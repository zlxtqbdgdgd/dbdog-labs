#!/usr/bin/env node
// loop-judge.mjs — 三条 loop 里的 ③：检测新增诊断 → 判题。
//
// 它是**消费者**：自己去查「跑过但没判过」的诊断，不等 ② 递给它。两条理由（设计 §2.3）：
//   ① 诊断不只从批跑来——用户自己在 Claude Code 里发一句「诊断: …」也会产出 trace；
//   ② 并成一条会让 ② 的进度依赖 ③ 活着，判题挂了诊断跟着堵。
//
// 出队有两处，各管各的：
//   · **批注**写回后 server 自动盖 `evaluation.*` 标签，下一轮算差集时它自然不在了；
//   · **诊断表**（server 蓝图 pg/0025）那一行由本脚本显式推到 `judged`。
// 两者不冲突：差集管的是「这条 trace 判过没有」，表管的是「这次复现走到哪一步了」。
// 表是给人看进度的（页面上那一列），判题的判据仍是差集——诊断不只从批跑来，
// 用户自己在 Claude Code 里发一句「诊断: …」也会产出 trace，那种 trace 根本没有表行。
// 所以**有表行就推，没有就跳过**，不拿表行的有无当判题的准入条件。
//
// 一轮做三步（每步都复用已有脚本，判据不在这里重写）：
//   导包 judge-package-export.mjs → 起判题会话（按包里 skill/SKILL.md 判）→ 回流 judge-package-import.mjs
// 走包是为了省一次取数（轨迹与答案纸先摆好），**不是**为了让判题会话脱离 dbdog：
// 本轮是「取数判题」，会话必须挂 MCP，缺的材料现取（见 lib/judge-session.mjs 顶部注释）。
//
// 用法：
//   node scripts/llmobs/loop-judge.mjs --dataset <用例集> [--project default-project]
//     [--limit N] [--model M] [--timeout-sec 1800] [--keep-package] [--dry-run]
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
import { DIAG_JUDGED, DIAG_JUDGING, DIAG_PENDING_JUDGEMENT, advanceDiagnosis, listDiagnoses } from "./lib/case-diag-client.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const argOf = (n, d) => { const i = process.argv.indexOf(n); return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : d; };
const has = (n) => process.argv.includes(n);
const fail = (m) => { console.error(`✗ ${m}`); process.exit(1); };

const PROJECT = argOf("--project", "default-project");
const DATASET = argOf("--dataset", "");
const LIMIT = Number(argOf("--limit", "0"));
const MODEL = argOf("--model", "");
const TIMEOUT_MS = Number(argOf("--timeout-sec", "1800")) * 1000;
const KEEP = has("--keep-package");
// 推诊断表状态时报上的经手人（落进 status_changed_by，页面上「被谁改的」显的就是它）。
// 与诊断那条 loop 的 --claimed-by 同一个形状：机器名带上，一台机器跑多条时看得出是哪条。
const JUDGED_BY = argOf("--judged-by", `loop-judge@${os.hostname()}`);
const DRY = has("--dry-run");
if (!DATASET) fail("--dataset 必填");

// ---- ① 捞：哪些诊断还没判过（单源在 loop-pending.mjs） ----
const pending = await spawnScript(HERE, "loop-pending.mjs", ["--project", PROJECT, "--dataset", DATASET, "--kind", "judge", "--json"], { capture: true });
if (pending.code !== 0) fail("loop-pending 失败（上面是它的输出）");
let needJudge;
try { needJudge = JSON.parse(pending.out).need_judge ?? []; } catch { fail(`loop-pending 的 JSON 解析不了：${pending.out.slice(0, 200)}`); }

if (needJudge.length === 0) {
  console.error(`本轮无事：用例集 ${DATASET} 里没有跑过但没判过的诊断。`);
  process.exit(0);
}

// **一例一个会话**（不是一轮一个）。判题包本来就支持按 event id 挑子集
// （judge-package-export --cases），早前按轮导是编排层自己加的限制，代价很大：
// 三例材料叠起来 11 MB 塞进一个会话，40 分钟没判完；而且一例失败整轮都不回流。
const cases = needJudge.filter((r) => {
  if (r.experiment && r.eventId) return true;
  console.error(`⚠ 跳过 trace ${String(r.traceId).slice(0, 10)}：没挂在 run 上或缺 event id，判题包导不出来`);
  return false;
});
const groups = LIMIT > 0 ? cases.slice(0, LIMIT) : cases;
console.error(`待判 ${needJudge.length} 条，可判 ${cases.length} 条${LIMIT > 0 ? `，本轮取前 ${groups.length} 条` : ""}（一例一个会话）`);

// 诊断表里「待判题 / 判题中」那批：按 trace_id 认人，开判前推到 judging，判完推到 judged。
// 拿不到不阻断——判题的判据是差集，表只是进度展示（见文件头注）。
//
// **judging 也要捞回来**：判题进程被杀会把行留在 judging，而差集下一轮照样把这条算成待判
//（批注没落库）。只捞 pending_judgement 的话，那一行会永远停在「判题中」没人再碰它。
let diagByTrace = new Map();
try {
  const rows = await listDiagnoses({ statuses: [DIAG_PENDING_JUDGEMENT, DIAG_JUDGING], limit: 1000 });
  diagByTrace = new Map(rows.filter((d) => d.trace_id).map((d) => [d.trace_id, d]));
  console.error(`· 诊断表里待判题 / 判题中 ${rows.length} 条`);
} catch (e) {
  console.error(`⚠ 读诊断表失败，本轮只判题不推进度：${e.message || e}`);
}

const JUDGE_PROMPT = `本目录是一个**自包含判题包**。请：

1. 先读 \`skill/SKILL.md\`，那是判题口径的正文，严格按它判。
2. 逐个读 \`cases/<event_id>/\` 下的材料判分。每例的材料可能有：
   - \`forward.md\`  正向假设树（agent 实际提了哪些假设、各拿什么证据、怎么收口）
   - \`reverse.md\`  反向证据链（从答案倒推「本该留下哪些痕迹」）
   - \`ground-truth.md\` 答案纸（**可能没有**——没有就是无参照题，按 skill 里的无参照口径判）
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

两条硬规矩：**归因必须指到某条 span 或探针结果的某一行**；**建议必须写清「改哪里」**。
判不了的照实写判不了，不要猜一个填上。`;

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

let okN = 0, failN = 0;
for (const c of groups) {
  console.error(`\n════ 判 ${c.eventId}（trace ${String(c.traceId).slice(0, 10)}，轮次 ${c.experiment}）════`);
  const pkg = fs.mkdtempSync(path.join(os.tmpdir(), "judge-pkg-"));
  let thisOk = false;   // 这一例成没成——失败的包要留着给人看，不能按全局计数删
  try {
    const exp = await spawnScript(HERE, "judge-package-export.mjs", ["--project", PROJECT, "--dataset", DATASET, "--experiment", c.experiment, "--cases", c.eventId, "--out", pkg]);
    if (exp.code !== 0) { console.error(`✗ 导包失败：${c.eventId}`); failN++; continue; }

    if (DRY) { console.error(`（--dry-run）包在 ${pkg}，不起判题会话、不回流`); okN++; continue; }   // dry-run 的包一律留着看

    // 开判前先把诊断表那行推到「判题中」。这一步**同时是互斥**：advance 带 from 断言，
    // 两轮 loop 同时打进来只有一轮改得动，后到的那轮拿到 409（下面的 row 为 null）。
    // 改不动不跳过这一例：判题的判据是差集，行已经在 judging 多半是上一轮被杀留下的，
    // 那条仍然没有批注、仍然该判。这里只是不再重复推一次状态。
    const diag = diagByTrace.get(c.traceId);
    if (diag && diag.status === DIAG_PENDING_JUDGEMENT) {
      try {
        const row = await advanceDiagnosis({ id: diag.id, from: DIAG_PENDING_JUDGEMENT, to: DIAG_JUDGING, by: JUDGED_BY });
        if (row) diag.status = DIAG_JUDGING;
        else console.error(`· ${diag.case_source} 已不在待判题（多半另一轮先领走了），本轮照判但不改它的状态`);
      } catch (e) {
        console.error(`⚠ ${diag.case_source} 推「判题中」失败（不影响判题）：${e.message || e}`);
      }
    }

    console.error(`⚖ 判题会话开跑（包在 ${pkg}）…`);
    let prose = "";
    try {
      // 参数（含「必须挂 MCP」那条硬判据）单源在 lib/judge-session.mjs。
      const res = await runAgentCli({
        prompt: JUDGE_PROMPT,
        ...judgeSessionArgs({ mcpConfigPath, model: MODEL || undefined, cwd: pkg, timeoutMs: TIMEOUT_MS }),
      });
      prose = res.prose || "";
    } catch (e) {
      console.error(`✗ 判题会话失败：${e.message || e}`);
      failN++; continue;
    }

    const annFile = path.join(pkg, "annotations.jsonl");
    if (!fs.existsSync(annFile) || fs.statSync(annFile).size === 0) {
      // 没产出批注就不回流：回流一个空文件会把「判过了」的假象写进去，下一轮就再也捞不到它。
      console.error(`✗ 判题会话没写出 annotations.jsonl，不回流（包留在 ${pkg}）`);
      console.error(`  会话结尾：${prose.slice(-300)}`);
      failN++; continue;
    }

    const imp = await spawnScript(HERE, "judge-package-import.mjs", ["--package", pkg, "--annotator", MODEL || "default"]);
    if (imp.code !== 0) { console.error(`✗ 回流失败：${c.eventId}（包留在 ${pkg}）`); failN++; continue; }
    okN++; thisOk = true;

    // 批注回流成功之后才推「已判」：顺序反过来的话，页面会先显示「已判」而批注还没写进去，
    // 中间那段时间里点开看是空的。推进度失败不算判题失败——批注已经落库了，
    // 页面上那一行停在「判题中」只是显示滞后，下一轮还会再推一次。
    if (diag) {
      try {
        const row = await advanceDiagnosis({ id: diag.id, from: diag.status, to: DIAG_JUDGED, by: JUDGED_BY });
        if (!row) console.error(`· ${diag.case_source} 已不在 ${diag.status}（多半是重判），不改它的状态`);
      } catch (e) {
        console.error(`⚠ ${diag.case_source} 推进度失败（批注已回流，不影响判题结果）：${e.message || e}`);
      }
    }
  } finally {
    if (!KEEP && thisOk) { try { fs.rmSync(pkg, { recursive: true, force: true }); } catch { /* */ } }
  }
}

console.error(`\n== 本轮判题：成 ${okN} 例 · 败 ${failN} 例 ==`);
process.exit(failN > 0 ? 1 : 0);
