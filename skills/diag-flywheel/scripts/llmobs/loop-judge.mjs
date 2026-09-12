#!/usr/bin/env node
// loop-judge.mjs — 三条 loop 里的 ③：领「待判题」的复现 → 判题。
//
// **判据是诊断表，不是差集**（owner 2026-09-11 定：「judge 只看状态是待判题的，先改状态为
// 判题中，再判题，判完之后先上报，再改为判完」）。一轮四步，顺序不能换：
//
//   ① 抢：pending_judgement → judging（server 单条 FOR UPDATE SKIP LOCKED，抢占即互斥）
//   ② 判：导包 → 起判题会话
//   ③ 上报：judge-package-import.mjs 把批注写回
//   ④ 收：judging → judged
//
// ③ 必须排在 ④ 前面：反过来的话页面会先显「已判」而批注还没写进去，那段时间里点开是空的。
//
// ## 为什么从「现算差集」改成抢表（2026-09-11 实测的两个洞）
//
// 差集（`loop-pending --kind judge`）算的是「trace 跑过、还没有 evaluation.* 标签」，它是
// **按 trace 实时**的；而诊断侧只在**整轮收尾**才把行推到 pending_judgement。两边粒度不同，
// 于是同一天里两个方向都漏：
//   · 一例的 trace 刚上报、同轮别的用例还在跑，判题这边已经把它捞走判了——判的是一轮
//     还没结束的中间产物，而页面上那行还显示「诊断中」，没有任何一处看得出它正在被判；
//   · 等诊断轮真收尾把行推到 pending_judgement，差集里早没有这条了（批注写完了），
//     于是那行**永远停在「待判题」**，再没有人推它到 judged。
// 抢表把这两个洞一起堵上：队列只有一条，谁在判、判到哪一步都落在同一行上。
//
// 代价（已知，别当 bug 报）：**没有表行的 trace 不再自动判**——用户在 Claude Code 里手工
// 发一句「诊断: …」产出的 trace 就属于这种。那种要判，走 `diag-judge` skill 单条判，
// 或者先给它补一行复现回执。判题队列与「谁有资格进队列」是两件事，后者归复现那一侧。
//
// 一轮做三步（每步都复用已有脚本，判据不在这里重写）：
//   导包 judge-package-export.mjs → 起判题会话（按包里 skill/SKILL.md 判）→ 回流 judge-package-import.mjs
// 走包是为了省一次取数（轨迹与答案纸先摆好），**不是**为了让判题会话脱离 dbdog：
// 本轮是「取数判题」，会话必须挂 MCP，缺的材料现取（见 lib/judge-session.mjs 顶部注释）。
//
// 用法：
//   node scripts/llmobs/loop-judge.mjs --dataset <用例集> [--project default-project]
//     [--limit N] [--model M] [--timeout-sec 1800] [--keep-package] [--dry-run]
//     [--claimed-by <loop 实例名>] [--stale-after-sec <租约时长>]
//
// env 同 run-experiment（DBDOG_BASE_URL + DBDOG_API_KEY）。
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnScript } from "./lib/spawn-script.mjs";
import { runAgentCli } from "../e2e/lib/agent-cli.mjs";
import { buildMcpConfig } from "../e2e/lib/e2e-agent.mjs";
import { judgeSessionArgs, judgeMcpUrl } from "./lib/judge-session.mjs";
import { resolveDatasetTraces } from "./lib/dataset-traces.mjs";
import { matchJudgeTargets, walkJudgeQueue } from "./lib/judge-queue.mjs";
import { DIAG_JUDGED, DIAG_JUDGING, DIAG_PENDING_JUDGEMENT, advanceDiagnosis, claimDiagnosis, listDiagnoses, operator } from "./lib/case-diag-client.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const argOf = (n, d) => { const i = process.argv.indexOf(n); return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : d; };
const has = (n) => process.argv.includes(n);
const fail = (m) => { console.error(`✗ ${m}`); process.exit(1); };

const PROJECT = argOf("--project", "default-project");
const DATASET = argOf("--dataset", "");
const LIMIT = Number(argOf("--limit", "0"));
// 判官用强模型（owner 2026-09-11 定）。**默认值不是空串**：空串既不会给会话钉模型
// （跑成 CLAUDE_CONFIG_DIR 那份配置的默认模型，可能是便宜模型），又会把 `--annotator` 落成
// "default"——而 annotator 存在的理由正是「两轮结论不一样时分得清是 agent 变了还是判官换了」。
// 判官换模型就显式传 `--model`，别靠环境里的默认值。
const MODEL = argOf("--model", "opus");
const TIMEOUT_SEC = Number(argOf("--timeout-sec", "1800")) || 1800;
const TIMEOUT_MS = TIMEOUT_SEC * 1000;
const KEEP = has("--keep-package");
const DRY = has("--dry-run");
// claimed_by 记**哪条 loop** 占着租约（卡住时去哪台机器看），与诊断侧同一个格式。
const CLAIMED_BY = argOf("--claimed-by", `loop-judge@${os.hostname()}`);
// 租约时长按**判题超时 × 2** 取，理由与诊断侧同一条（见 loop-diagnose.mjs）。
const STALE_AFTER_SEC = Number(argOf("--stale-after-sec", String(TIMEOUT_SEC * 2)));
// `--limit N` = 本轮最多判几条；不给 = 判到队列空为止（一条一条领，见下面的流式循环）。
const MAX_PER_ROUND = LIMIT > 0 ? LIMIT : 0;
if (!DATASET) fail("--dataset 必填");
// 报上跑的人是谁（DBDOG_OPERATOR）。**在抢任何东西之前就查**：抢到手的行会被改成 judging
// 占住租约，等跑到推状态那一步才发现缺这个变量，那批行就得等租约超时才被捞回来。
try { operator(); } catch (e) { fail(e.message); }

// ---- 先做所有「不领活也能做」的检查，再去抢 ----
//
// 顺序是有代价的：抢到手的行会被改成 judging 占住租约，等跑到一半才发现缺变量 / 用例集解析不出来，
// 那批行就得等租约超时才被捞回来，页面上它们一直显示「正在判」。所以解析用例集、MCP 配置、
// bearer 这三件都排在抢之前。

let runsByRecord = new Map();
try {
  ({ runsByRecord } = await resolveDatasetTraces({ project: PROJECT, dataset: DATASET }));
} catch (e) {
  fail(`解析用例集 ${DATASET} 的历次 run 失败：${e.message || e}`);
}

// MCP 配置写一份给所有判题会话共用（与诊断会话同一份 buildMcpConfig，连的是同一个 dbdog）。
// 判题连的不是诊断那份地址——要补上 llmobs toolset（见 lib/judge-session.mjs 的 judgeMcpUrl）。
const mcpConfigPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "judge-mcp-")), "mcp.json");
process.env.DBDOG_MCP_URL = judgeMcpUrl(process.env.DBDOG_MCP_URL ?? "");
fs.writeFileSync(mcpConfigPath, JSON.stringify(buildMcpConfig(), null, 2));
if (!process.env.DBDOG_MCP_BEARER?.trim()) {
  // 边缘口有 OAuth 门禁，headless 起的会话读不到交互式客户端的登录态——没 bearer 就是连不上，
  // 与其让判题模型「工具全报错还照判」，不如现在就停。
  fail("判题会话要连 dbdog 取证据，缺 DBDOG_MCP_BEARER（scripts/llmobs/mint-mcp-jwt.mjs 铸）");
}

const JUDGE_PROMPT = `本目录是一个**自包含判题包**。请：

1. 先读 \`skill/SKILL.md\`，那是判题口径的正文，严格按它判。
2. 逐个读 \`cases/<event_id>/\` 下的材料判分。每例的材料可能有：
   - \`forward.md\`  正向假设树（agent 实际提了哪些假设、各拿什么证据、怎么收口）
   - \`ground-truth.md\` 答案纸（**可能没有**——没有就是无参照题，按 skill 里的无参照口径判）
   - \`prior-judgments.json\` 这道题之前几轮的判题（改进点、复验、修复标记）。
     **还没关的每一条都要在 \`findings.checks\` 里复验，一条都不许漏**；
     打过 \`claimed_fixed\` 标记的要特意走到那条路去验——标记是声明，复验才是判决。
   - \`reverse.md\`  反向证据链（从答案倒推「本该留下哪些痕迹」）
   - \`probe.json\`  探针结果（同样的工具、同样的参数由固定代码重放一遍的存否）
   - \`trace.json\`  原始 span（**几 MB，不要通读**）。\`forward.md\` 已经是它的结构化摘要；
     只在要核对某一条具体证据时，去里面搜那一条。
3. **这一轮是「取数判题」，不是「包判题」** —— 包只是把轨迹与答案纸先给你省一次取数，
   **你手上有 dbdog 工具，该查就查**。skill 里「包判题不能回头追问」那条不适用于本轮。
   材料里缺的那一件（探针结果 / 反向证据链）就靠现取来补：
   拿这次诊断的实例与时间窗，去查「模型说没有的那条证据，究竟是它没想到查，还是查了也确实没有」——
   这是「要修 dbdog」这一项唯一的硬判据（飞轮 D2）。别只凭轨迹猜。
4. 产出两个文件，写在本目录下：
   - \`annotations.jsonl\` 每行一条 JSON，格式见 \`skill/SKILL.md\` 与 \`manifest.json\` 里的 label schema。
     **同一条 trace 只许一行**（重判是覆盖，不是追加）。
   - \`summary.md\`  本轮总账。

回流会**整包拒写**的四件事（写之前自己对一遍）：
- 有答案纸的题必须写 \`findings.roots\`（按答案纸里根因的出现顺序编号，划进 matched / missed，
  不重不漏），且 \`verdict\` 要与集合对得上：找齐 correct、找到一部分 partial、没找到 wrong；
  没有答案纸的题 \`verdict\` 只能 unknown，且不写 roots。
- 每条改进点的 \`span_id\` 指针必须在这条 trace 里真找得到（前 8 位也行，但不能配到两条）。
- \`tool\` 类要写 \`layer\`（server / agent / hooks / scripts）与 \`repro\`；\`tool\` 与 \`skill\` 类要写
  \`qualifier\`（missing 缺失 / incorrect 写错 / extraneous 多余）。
- \`model\` 类要写 \`rule_ref\`（规矩写在哪个 skill 的哪一节）；\`unsure\` 类要写 \`suspected_kind\`。

两条硬规矩：**归因必须指到某条 span 或探针结果的某一行**；**建议必须写清「改哪里」**。
判不了的照实写判不了，不要猜一个填上。`;

// 积压要报出来，哪怕本轮一条没领：数字悄悄变小很危险——不报，看到的人会以为「都判完了」，
// 而真相可能是诊断那一侧没跟上，或者一堆行卡在 judging 等租约。
try {
  const backlog = await listDiagnoses({ statuses: [DIAG_PENDING_JUDGEMENT], limit: 1000 });
  const inflight = await listDiagnoses({ statuses: [DIAG_JUDGING], limit: 1000 });
  console.error(`· 队列：待判题 ${backlog.length} 条 · 判题中 ${inflight.length} 条（各自最多数到 1000）`);
} catch { /* 看板信息，拿不到不阻断本轮 */ }

// ---- 一条一条地领：判完一条再领下一条 ----
//
// 队列怎么走（为什么不是一次领完、为什么配不上的要攥住）单源在 lib/judge-queue.mjs 的
// `walkJudgeQueue`，那里有判据也有用例；这里只把「怎么判一条」接上去。

/** 把一行放回「待判题」。放不回去也只是等租约，不阻断本轮。 */
const release = async (row) => {
  try { await advanceDiagnosis({ id: row.id, from: DIAG_JUDGING, to: DIAG_PENDING_JUDGEMENT }); }
  catch { /* 等租约回收 */ }
};

const UNRESOLVED_WHY = {
  no_trace: "行上没有 trace（诊断侧该在拿到 trace 时才推待判题）",
  foreign: `trace 不属于用例集 ${DATASET}（抢占是全局的：诊断表上没有用例集这一维）`,
  no_event: "配到了 run 但缺 event id，判题包导不出来",
  duplicate_trace: "同一条 trace 本轮已经判过，判两遍批注会互相覆盖",
};

/** 判一条：导包 → 判题会话 → 回流 → 推「已判」。回 true 算成。 */
async function judgeOne(c) {
  console.error(`\n════ 判 ${c.eventId}（trace ${String(c.traceId).slice(0, 10)}，轮次 ${c.experiment}）════`);
  const pkg = fs.mkdtempSync(path.join(os.tmpdir(), "judge-pkg-"));
  let thisOk = false;   // 这一例成没成——失败的包要留着给人看，不能按全局计数删
  try {
    const exp = await spawnScript(HERE, "judge-package-export.mjs", ["--project", PROJECT, "--dataset", DATASET, "--experiment", c.experiment, "--cases", c.eventId, "--out", pkg]);
    if (exp.code !== 0) { console.error(`✗ 导包失败：${c.eventId}`); return false; }

    // dry-run 的包一律留着看；行在 finally 里放回待判题，空跑不该把队列消掉。
    if (DRY) { console.error(`（--dry-run）包在 ${pkg}，不起判题会话、不回流`); return false; }

    console.error(`⚖ 判题会话开跑（判官 ${MODEL}，包在 ${pkg}）…`);
    let prose = "";
    try {
      // 参数（含「必须挂 MCP」那条硬判据）单源在 lib/judge-session.mjs。
      const res = await runAgentCli({
        prompt: JUDGE_PROMPT,
        ...judgeSessionArgs({ mcpConfigPath, model: MODEL, cwd: pkg, timeoutMs: TIMEOUT_MS }),
      });
      prose = res.prose || "";
    } catch (e) {
      console.error(`✗ 判题会话失败：${e.message || e}`);
      return false;
    }

    const annFile = path.join(pkg, "annotations.jsonl");
    if (!fs.existsSync(annFile) || fs.statSync(annFile).size === 0) {
      // 没产出批注就不回流：回流一个空文件会把「判过了」的假象写进去，下一轮就再也捞不到它。
      console.error(`✗ 判题会话没写出 annotations.jsonl，不回流（包留在 ${pkg}）`);
      console.error(`  会话结尾：${prose.slice(-300)}`);
      return false;
    }

    const imp = await spawnScript(HERE, "judge-package-import.mjs", ["--package", pkg, "--annotator", MODEL]);
    if (imp.code !== 0) { console.error(`✗ 回流失败：${c.eventId}（包留在 ${pkg}）`); return false; }
    thisOk = true;

    // 批注回流成功之后才推「已判」：顺序反过来的话，页面会先显示「已判」而批注还没写进去，
    // 中间那段时间里点开看是空的。推不动不算判题失败（批注已落库），但也不是纯显示问题——
    // 那一行会留在「判题中」，等租约到期被下一轮捞回去**重判一遍**（再烧一次判题会话、批注被覆盖）。
    try {
      const moved = await advanceDiagnosis({ id: c.row.id, from: DIAG_JUDGING, to: DIAG_JUDGED });
      if (!moved) console.error(`· ${c.row.case_source} 已不在判题中（租约多半被回收了），不改它的状态`);
    } catch (e) {
      console.error(`⚠ ${c.row.case_source} 推「已判」失败（批注已回流；这一行会留在判题中，下一轮租约到期会被重判）：${e.message || e}`);
    }
    return true;
  } finally {
    if (!KEEP && thisOk) { try { fs.rmSync(pkg, { recursive: true, force: true }); } catch { /* */ } }
    // 没判成的**当场放回待判题**，不留在 judging 等租约：留着的话页面上它一直显示
    // 「判题中」，是在骗人，而且要等一个判题超时 × 2 才有人再碰它。
    if (!thisOk) await release(c.row);
  }
}

const { ok: okN, failed: failN, skipped } = await walkJudgeQueue({
  claim: () => claimDiagnosis({
    claimedBy: CLAIMED_BY, staleAfterSec: STALE_AFTER_SEC,
    from: DIAG_PENDING_JUDGEMENT, to: DIAG_JUDGING,
  }),
  // 行上只有 trace_id，而导包要 experiment + event id（judge-package-export 按 event id 挑子集）。
  // 这座桥在 lib/judge-queue.mjs，配不上的带理由分流出来。
  resolve: (row) => {
    const { targets, unresolved } = matchJudgeTargets([row], runsByRecord);
    return targets[0] ? { target: targets[0] } : { reason: unresolved[0]?.reason };
  },
  judge: judgeOne,
  release,
  limit: MAX_PER_ROUND,
  onSkip: (row, reason) => console.error(`· 放回 ${row.case_source}：${UNRESOLVED_WHY[reason] ?? reason}`),
});

if (okN + failN + skipped === 0) console.error("本轮无事：诊断表里没有待判题的复现。");
console.error(`\n== 本轮判题：成 ${okN} 例 · 败 ${failN} 例${skipped ? ` · 放回 ${skipped} 条` : ""} ==`);
process.exit(failN > 0 ? 1 : 0);
