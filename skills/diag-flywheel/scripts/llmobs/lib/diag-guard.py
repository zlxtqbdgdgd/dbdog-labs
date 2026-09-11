#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""诊断会话的 PreToolUse 护栏——补上 permissions.deny 挡不住的两个洞。

背景(2026-08-16 实测):
  ① `deny: Read(//<语料仓>/**)` 只作用于 **Read 工具**。同一条路径用 Bash 的
     `cat` / `head` / `grep` / `awk` / `python3 -c open(...)` 读,不经过 Read 的
     权限判定,一个字节都不挡——盲测护栏形同虚设。Grep / Glob 两个工具的 `path`
     参数同样不在 Read 规则的覆盖面里。
  ② `ps aux` 的回显里带着 harness 自己的命令行:
       bash run-case.sh OG-7152 --no-reproduce --window '...'
       bash lib/diagnose.sh OG-7152 '...' /…/loop/runs/OG-7152-20260816-…
     用例编号、run 目录、甚至复现脚本路径全在里面。诊断 agent 只要 `ps` 一次,
     就知道自己在被测什么、答案目录叫什么——这是 B1 首次观察到的新泄漏面。

做法:PreToolUse 钩子拿到 tool_input 后自己判,**退出码 2 = 拒绝**(stderr 回灌给模型)。
钩子在 `--dangerously-skip-permissions` 下照常执行,不受权限模式影响,所以它是比
permissions 更硬的一层。permissions.deny 保留不动,两层并存。

用法(由 diagnose.sh 写进 diag_settings.json):
    python3 diag-guard.py <deny_root> [<deny_root> ...]
或把 ROOTS_OVERRIDE 那一行替换成字面量后按 `python3 <副本>` 调用(不带参数)。

**为什么要有 ROOTS_OVERRIDE 这条看着多余的路**:钩子被拒时,Claude Code 把**钩子命令行原样**
回灌给模型("PreToolUse:Bash hook error: [<命令行>]: <stderr>")。若禁读根写在 argv 里,
agent 只要触一次护栏(哪怕只是 `ps aux`)就白拿到两条语料仓绝对路径——护栏自己成了指路牌。
2026-08-16 实测到这一幕后改成:每轮把本文件复制进随机临时目录、把根写死进副本,
钩子命令行只剩 `python3 /var/folders/…/g.py`,不含用例编号、run 目录、语料仓路径。
同理,拒绝理由里**不回显**禁读根与命中的关键词本身。

判据只有三条,尽量少误伤:
  A. 命中任一 deny 根的绝对路径(Bash 命令正文里出现即算,不做 shell 解析——
     解析不全反而漏);
  B. 命中答案源关键词(语料仓名/外置盘镜像名/ground-truth/别名表…),
     诊断 openGauss 缺陷时没有任何一条合法路径需要提到它们;
  C. 本机进程/端口窥探命令(ps/pgrep/top/lsof/…)——被测库在远端 box 上,
     本机进程表里只有 harness 自己,对诊断零价值、对盲测是纯泄漏。

## 它为什么在这个仓（2026-09-11 从 opengauss-issue-corpus 搬来）
blind-guard.mjs 只做 permissions.deny 那一层，它自己写着「钩子脚本由调用方给」。
此前调用方各自带一份（语料仓一份、本机 loop runner 一份），后者把禁读根**硬编码**在源码里，
换台机器必须改文件。搬进来之后随 diag-flywheel 镜像进插件，谁装了插件谁就有。

## 禁读根为什么不能走 argv
钩子被拒时 Claude Code 把**钩子命令行原样**回灌给模型
（"PreToolUse:Bash hook error: [<命令行>]: <理由>"）。禁读根写进 argv，agent 触一次护栏
就白拿到答案目录的绝对路径——护栏本身成了泄漏面。
所以调用方要把本文件拷进随机临时目录、把 ROOTS_OVERRIDE 那一行替换成字面量，
再按 `python3 <副本>` 调用（不带参数）。lib/blind-guard.mjs 的 installGuardCopy 封装了这一步。
"""
import json
import os
import re
import sys

# 由 diagnose.sh 逐行替换成字面量列表(见上方说明)。留空则回退读 argv。
ROOTS_OVERRIDE = []

# B 类:答案源与 harness 身份关键词。命中即拒(不区分大小写)。
# 说明:`dbdog` 本身也在列——诊断走的是 MCP 工具(dbdog__*),那不经过 Bash;
# Bash 命令正文里出现 dbdog 只可能是在翻 harness 仓或语料仓。
ANSWER_TOKENS = (
    "opengauss-issue-corpus",
    "dbdog-corpus",
    "wd_black",
    "ground-truth",
    "ground_truth",
    "_alias-map",
    "repro-status",
    "repro-candidates",
    "dbdog",
    ".datadog",
    # agent 自己的会话存档目录:里面躺着**历史轮次**的完整轨迹。封堵联网之前的老圈曾把
    # gitee issue 正文与修复补丁 diff 抓回来,还有若干条 ground-truth 正文也进过这里
    # ——2026-08-16 实测 305MB/342 个会话文件,`grep -rl` 能直接捞出答案。
    # 注意与**本圈自己的溢出文件**区分:那些落在 <会话>/tool-results/ 下,是 agent 自己
    # 刚拿到的工具返回体被 Claude Code 转存的,读回来天经地义,见下方 SPILL_RE 的豁免。
    ".claude/projects",
    ".claude/history",
    ".claude/todos",
    ".claude/shell-snapshots",
)

# 本圈自己的工具返回体溢出文件。Claude Code 在返回体过大时把它写到
# <project>/<session>/tool-results/ 下、并让 agent 自己 Read 回来——这是**正常取证动作**,
# 路径里恰好带 `dbdog`(文件名形如 mcp-dbdog-search_dbdog_logs-<ts>.txt)与 `.claude/projects`,
# 会被上面两类判据同时误伤。2026-08-16 实测:B2 首批 5 圈被这条误伤 12 次,
# OG-7458 有 4 次——agent 被挡在自己刚取回的日志外面,该圈作废重跑。
# 做法:判定前先把这类路径整段抠掉,再拿**剩下的文本**过判据。
# 于是「只读自家溢出文件」放行,而「读自家溢出文件 + 顺手 cat 语料仓」仍然拦得住。
SPILL_RE = re.compile(r"""[^\s"']*/tool-results/[^\s"']*""")

# C 类:本机进程/端口/会话窥探。取管道每一段的首个词判定。
PEEK_CMDS = {
    "ps", "pgrep", "pkill", "top", "htop", "lsof", "netstat", "ss",
    "who", "w", "last", "launchctl", "sample", "vmmap", "dtrace", "fs_usage",
}

PATH_KEYS = ("file_path", "path", "notebook_path", "filePath")


def norm(text):
    return (text or "").replace("\\", "/")


def hits_root(text, roots):
    low = norm(text)
    for r in roots:
        if r and r in low:
            return r
    return None


def first_words(cmd):
    """管道/分隔符切段后每段的首个词(剥掉 env 赋值与 sudo/command 前缀)。"""
    out = []
    for seg in re.split(r"[|;&]+|\$\(|`|\n", cmd or ""):
        for tok in seg.strip().split():
            if "=" in tok and not tok.startswith("-") and re.match(r"^\w+=", tok):
                continue
            if tok in ("sudo", "command", "env", "nohup", "time", "exec"):
                continue
            out.append(os.path.basename(tok.strip("\"'()")))
            break
    return out


def deny(reason):
    sys.stderr.write(
        "盲测护栏拒绝了这次调用:%s\n"
        "这条通道与本次诊断无关。请只用 dbdog MCP 工具取遥测证据、"
        "用 Read/Grep 读当前工作目录下的被测版本源码树。\n" % reason
    )
    sys.exit(2)


def main():
    src = ROOTS_OVERRIDE or sys.argv[1:]
    roots = [norm(a).rstrip("/").lower() for a in src if a.strip()]
    try:
        payload = json.load(sys.stdin)
    except Exception:
        sys.exit(0)  # 读不动就放行:护栏坏掉不该把整轮诊断卡死(deny 规则仍在)
    tool = payload.get("tool_name", "") or ""
    ti = payload.get("tool_input", {}) or {}

    if tool == "Bash":
        cmd = ti.get("command", "") or ""
        low = SPILL_RE.sub(" ", cmd.lower())
        if hits_root(low, roots):
            deny("命令正文引用了一条盲测禁读路径(deny 规则只挡 Read 工具,Bash 读同路径由本护栏挡)")
        for tok in ANSWER_TOKENS:
            if tok in low:
                deny("命令正文出现了答案源/评测 harness 的标识,与本次诊断无关")
        for w in first_words(cmd):
            if w in PEEK_CMDS:
                deny("`%s` 会列出本机进程/端口,回显里带着评测 harness 的命令行(用例编号、run 目录)" % w)
        sys.exit(0)

    # Read/Grep/Glob/Edit/… 的路径参数:Read 有 deny 规则兜着,Grep/Glob 没有,统一在这里再判一次。
    for key in PATH_KEYS:
        val = ti.get(key)
        if isinstance(val, str) and val:
            val = SPILL_RE.sub(" ", val.lower())
            if not val.strip():
                continue          # 整条路径就是本圈自己的溢出文件,放行
            if hits_root(val.lower(), roots):
                deny("%s 的路径参数指向盲测禁读范围" % tool)
            for tok in ANSWER_TOKENS:
                if tok in val:
                    deny("%s 的路径参数出现了答案源/评测 harness 的标识" % tool)
    sys.exit(0)


if __name__ == "__main__":
    main()
