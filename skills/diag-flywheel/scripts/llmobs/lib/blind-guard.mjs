// blind-guard.mjs —— 盲测护栏：把「禁读某些路径 / 禁绕道」的规则，与采集钩子合并成
// 一份 `--settings` JSON。
//
// 为什么要它：评测跑的是**盲**诊断——agent 只该靠遥测与源码推出根因。但答案往往就在同一台
// 机器上（社区 issue 原文、历史轮次报告），不挡住的话它 grep 一次就抄到了，而且没有任何迹象：
// 跑批照跑、分数照涨。
//
// 为什么两层缺一不可（口径来自 opengauss-issue-corpus/loop/lib/diagnose.sh，2026-08-16 实测）：
//   ① permissions.deny —— 挡工具面。`Read(//x/**)` 只作用于 Read 工具，Grep/Glob 各有自己的
//      path 参数，不吃 Read 规则，所以每个根要三条。deny 在 --dangerously-skip-permissions
//      下依然生效（已实测）。
//   ② PreToolUse 钩子 —— 补 deny 挡不住的洞：`cat`/`grep`/`head` 走 Bash 读同一条路径，
//      deny 一个字节都不挡。钩子退出码 2 = 拒绝并把理由回灌给模型，比 permissions 更硬。
//      钩子脚本由调用方给（本仓不预置评测专用的禁读根）。
//
// 注意：钩子的命令行会被原样回灌给模型（"PreToolUse:Bash hook error: [<命令行>]: <理由>"），
// 所以调用方**不要**把禁读根写进钩子的 argv——否则 agent 触一次护栏就白拿到答案目录的绝对路径。

/** 绕道通道：出网抓原文、查进程反推自己在被测哪一例。与禁读根无关，恒挡。 */
const ALWAYS_DENY = [
  "WebSearch", "WebFetch",
  "Bash(curl:*)", "Bash(wget:*)", "Bash(nc:*)", "Bash(ncat:*)", "Bash(telnet:*)",
  "Bash(ssh:*)", "Bash(scp:*)", "Bash(sftp:*)",
  "Bash(git clone:*)", "Bash(git fetch:*)", "Bash(git pull:*)",
  "Bash(pip install:*)", "Bash(pip3 install:*)", "Bash(npm install:*)", "Bash(brew:*)",
  // ps 一类本机进程窥探：钩子里按首词精判，这里再挡一次最常见的裸调用形态
  "Bash(ps:*)", "Bash(pgrep:*)", "Bash(top:*)", "Bash(lsof:*)",
];

/** 护栏钩子盯的工具面：读文件的三个 + 跑命令的一个 + 写文件的两个。 */
export const GUARD_MATCHER = "Bash|Read|Grep|Glob|Edit|Write";

/**
 * 禁读根 → deny 规则。绝对路径规则要写双斜杠（`Read(//abs/path/**)`）。
 * 空根一律丢掉：`Read(///**)` 会把整块盘挡死，而症状是 agent 什么都读不了、看着像模型变笨。
 */
export function buildDenyRules(roots = []) {
  const clean = (roots ?? [])
    .map((r) => String(r ?? "").trim().replace(/\/+$/, ""))
    .filter((r) => r !== "" && r !== "/");
  const perRoot = clean.flatMap((r) => {
    const p = r.replace(/^\/+/, "");
    return [`Read(//${p}/**)`, `Grep(//${p}/**)`, `Glob(//${p}/**)`];
  });
  return [...ALWAYS_DENY, ...perRoot];
}

/**
 * 采集钩子 + 护栏 → 一份 settings 对象。
 * `permissions` 与 `hooks` 是并列的两个键，两样都要时合成一份即可——同一个 claude 进程
 * 只收一份 `--settings`，各传各的会互相覆盖。
 *
 * @param {object}   o
 * @param {object}   o.hooks              采集钩子（hooks.json 的 hooks 段），原样保留
 * @param {string[]} [o.denyRoots]        禁读根
 * @param {string}   [o.guardHookCommand] 护栏钩子的完整命令行；不给就不加钩子
 */
export function mergeAgentSettings({ hooks = {}, denyRoots = [], guardHookCommand = "" } = {}) {
  const out = { hooks: { ...hooks } };

  if (guardHookCommand) {
    out.hooks.PreToolUse = [
      ...(hooks.PreToolUse ?? []),
      { matcher: GUARD_MATCHER, hooks: [{ type: "command", command: guardHookCommand, timeout: 10 }] },
    ];
  }

  // 没有禁读根、也没有护栏钩子 = 调用方没要护栏：permissions 整个不出现，
  // 与「原来只传采集那份」逐字节等价，不给不需要护栏的真实用户加料。
  const wantsGuard = (denyRoots ?? []).some((r) => String(r ?? "").trim()) || Boolean(guardHookCommand);
  if (wantsGuard) out.permissions = { deny: buildDenyRules(denyRoots) };

  return out;
}
