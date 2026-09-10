---
name: span-graph
description: hook span 转假设图/树。输入 dbdog-obs hook 产出的 spans.jsonl 文件、server 导出的 span JSON,或含 spans.jsonl 的目录,输出正向假设图 markdown(假设↔假设父子、假设↔工具调用、收口、出现顺序、未挂到假设的调用、源码来源的假设有没有现场证据)。零模型,秒出。装了 dbdog-agent-obs 插件的会话在 SessionEnd 会自动出一份,本 skill 用于按需重出或对历史 span 出图。触发词:span-graph / 正向 / 假设图 / span 转图 / span 转树。
---

# span-graph —— 从 hook span 重构诊断实际走的路

零模型、纯格式化重构:读 span 上已有的假设标注,长出「实际走的路」。产物是一份 markdown(附同名 .json),之后由人拿它与 evidence-chain 的产物做对比;本 skill 到产出为止,不做对比、不调模型、不重跑诊断。

## 先看有没有现成的

装了 dbdog-agent-obs 插件的会话,trace 收尾(SessionEnd)时 hook 会自动出图:

```
~/.claude/dbdog-obs/graphs/<trace_id>/forward-path.md        (Windows: %USERPROFILE%\.claude\dbdog-obs\graphs\…)
```

设了 `DBDOG_OBS_DIR` 的话在那个目录下的 `graphs/`。失败留痕在同目录 `graph-worker.log`。用户要「刚才那次的假设图」,先找这里,没有再手动出。

## 输入

- 文件:一份 `spans.jsonl`(hook 每行一个 span),或 server 导出的 `{"spans":[...]}` / JSON 数组
- 目录:里面有 `spans.jsonl` 就用它;也可以直接给 `~/.claude/dbdog-obs/`(整份日志,用 `--trace` 或 `--session` 筛出那一次诊断)

span 来自 dbdog-obs hook:装好 hook 后发「诊断:」+ 题面,跑完 span 落在 `~/.claude/dbdog-obs/spans.jsonl`(Windows 是 `%USERPROFILE%\.claude\dbdog-obs\spans.jsonl`)。**想让每次诊断的 span 落到自己的目录**,开 Claude Code 前设 `DBDOG_OBS_DIR=<用例目录>`。

假设格式由 dbdog-mcp 的 `telemetry.intent` 参数描述定义(随 tools/list 到达任何客户端),不需要往题面里贴约定;agent 不按 `[H2<H1]` 写的调用,图里落到「未挂到假设」。

## 用法

`S` 指本 skill 的 `scripts` 目录。只要 Node(装插件本来就有),没有 Python 依赖。

```bash
node S/from_spans.mjs 路径/spans.jsonl
node S/from_spans.mjs 某次输出目录
node S/from_spans.mjs ~/.claude/dbdog-obs/spans.jsonl --trace <trace_id> --out 输出目录
```

产物默认写在输入旁(目录形态写在该目录里):`forward-path.md` + `forward-path.json` + `forward-conclusion.md`(被测 agent 的最终回答原文)。

## 用户在会话里怎么说,你(Claude)怎么接

- 「正向,把刚才这次的出图」→ 当前 trace_id 在 `~/.claude/dbdog-obs/<session_id>.json` 的 `trace_id` 字段;先看 `graphs/<trace_id>/forward-path.md` 在不在,在就直接贴假设树部分;不在(会话还没结束)就 `--trace <id>` 手动出。
- 「正向,span 文件在 <路径>\spans.jsonl,出假设图」→ 直接跑 `from_spans.mjs <路径>`,产物写在同目录;把假设树部分贴给用户,并点出未声明的假设、没 [H..] 头的调用、源码来源却没有现场证据的假设各有几处。
- 「正向,用 dbdog-obs 里最近一次诊断的 span,输出到 <单号目录>」→ 读 spans.jsonl,取 ts 最新的 trace_id,`--trace <id> --out <单号目录>`。
- 用户给的是目录 → 直接传目录,脚本自己找里面的 spans.jsonl。

不要自己解析 span 编树,也不要调模型总结;这个 skill 的产物就是脚本出的 markdown。

## 图怎么长

`tags.hypothesis_id` / `parent_hypothesis_id` 优先,否则解析 intent 的 `[H2<H1] type=…; claim=…; expect=…; close=…; intent=…; basis=…; code_ref=…`(英文键为准,中文键 类型/假设/判据/关/意图 仍认;与 hook 的 hypothesis.mjs、dbdog-web 控制台同一套规则)。markdown 里有:

- 假设树:缩进 = 父子;每个假设下面一张表,列出该假设名下的工具调用(seq 是整条 trace 的全局序号、时间、主会话或哪个子代理、工具、意图、状态)
- 源码来源的假设(`basis=source`)单独标出它有没有现场取证调用——没有的按约定只能算假设,不能进结论
- 假设出现顺序
- 假设收口(`close=` 谁在第几步关了谁;结论正文 How do we know 结尾的 hypothesis ledger 也认)
- 未挂到假设的调用,分三类如实标出、不编造:**未声明的假设**(只被 `[H2.1<H2]` 或 `close=` 引用、没有调用以 `[H2]` 开头,通常是「Propose [H2]」写在正文里);**intent 写了字段但没 `[H..]` 头**(agent 没守约定,附原文);**不带 intent 的本地工具**(Bash/Read/Agent 派发等,按工具名计数)

## 文件

```
SKILL.md
scripts/from_spans.mjs            入口(透传到 claude-code-hooks/graph.mjs)
references/hypothesis-format.md   假设一行的格式速查(定义单源是 dbdog-mcp 的 telemetry.intent 描述)
```

实现与测试在插件的 `claude-code-hooks/hypothesis-graph.mjs` / `hypothesis-graph.test.mjs`。
