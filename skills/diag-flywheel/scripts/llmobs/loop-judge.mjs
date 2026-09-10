#!/usr/bin/env node
// loop-judge.mjs — 三条 loop 里的 ③：检测新增诊断 → 判题。
//
// 它是**消费者**：自己去查「跑过但没判过」的诊断，不等 ② 递给它。两条理由（设计 §2.3）：
//   ① 诊断不只从批跑来——用户自己在 Claude Code 里发一句「诊断: …」也会产出 trace；
//   ② 并成一条会让 ② 的进度依赖 ③ 活着，判题挂了诊断跟着堵。
//
// 出队不需要显式动作：判题写回批注 → server 自动盖 `evaluation.*` 标签 → 下一轮算差集时
// 它自然不在了。所以不存在「判完了但忘了出队」这种状态漂移。
//
// 一轮做三步（每步都复用已有脚本，判据不在这里重写）：
//   导包 judge-package-export.mjs → 起判题会话（按包里 skill/SKILL.md 判）→ 回流 judge-package-import.mjs
// 为什么走包而不是让 agent 现取：包是自包含的，判题会话不需要 MCP 凭证，也不会因为
// 少取一件材料就判偏（D2 四件套必须全）。
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

// 按 experiment 分组：判题包是「一轮实验一个包」，同一轮的一次导完，不逐条导。
const byExperiment = new Map();
for (const r of needJudge) {
  if (!r.experiment) continue;   // 没挂到 run 上的诊断（手工发的那种）本版跳过，见文末「欠的账」
  if (!byExperiment.has(r.experiment)) byExperiment.set(r.experiment, []);
  byExperiment.get(r.experiment).push(r);
}
const orphan = needJudge.length - [...byExperiment.values()].reduce((a, b) => a + b.length, 0);
if (orphan > 0) console.error(`⚠ ${orphan} 条诊断没挂在任何 run 上，本版跳过（判题包按 run 导）`);

const groups = LIMIT > 0 ? [...byExperiment.entries()].slice(0, LIMIT) : [...byExperiment.entries()];
console.error(`待判 ${needJudge.length} 条，分属 ${byExperiment.size} 轮实验${LIMIT > 0 ? `，本轮取前 ${groups.length} 轮` : ""}`);

const JUDGE_PROMPT = `本目录是一个**自包含判题包**。请：

1. 先读 \`skill/SKILL.md\`，那是判题口径的正文，严格按它判。
2. 逐个读 \`cases/<event_id>/\` 下的材料判分。每例的材料可能有：
   - \`forward.md\`  正向假设树（agent 实际提了哪些假设、各拿什么证据、怎么收口）
   - \`reverse.md\`  反向证据链（从答案倒推「本该留下哪些痕迹」）
   - \`ground-truth.md\` 答案纸（**可能没有**——没有就是无参照题，按 skill 里的无参照口径判）
   - \`probe.json\`  探针结果（同样的工具、同样的参数由固定代码重放一遍的存否）
   - \`trace.json\`  原始 span
3. 产出两个文件，写在本目录下：
   - \`annotations.jsonl\` 每行一条 JSON，格式见 \`skill/SKILL.md\` 与 \`manifest.json\` 里的 label schema。
     **同一条 trace 只许一行**（重判是覆盖，不是追加）。
   - \`summary.md\`  本轮总账。

两条硬规矩：**归因必须指到某条 span 或探针结果的某一行**；**建议必须写清「改哪里」**。
判不了的照实写判不了，不要猜一个填上。`;

let okN = 0, failN = 0;
for (const [experiment, rows] of groups) {
  console.error(`\n════ 判 ${experiment}（${rows.length} 条待判）════`);
  const pkg = fs.mkdtempSync(path.join(os.tmpdir(), "judge-pkg-"));
  let thisOk = false;   // 这一轮成没成——失败的包要留着给人看，不能按全局计数删
  try {
    const exp = await spawnScript(HERE, "judge-package-export.mjs", ["--project", PROJECT, "--dataset", DATASET, "--experiment", experiment, "--out", pkg]);
    if (exp.code !== 0) { console.error(`✗ 导包失败：${experiment}`); failN++; continue; }

    if (DRY) { console.error(`（--dry-run）包在 ${pkg}，不起判题会话、不回流`); okN++; continue; }   // dry-run 的包一律留着看

    console.error(`⚖ 判题会话开跑（包在 ${pkg}）…`);
    let prose = "";
    try {
      // 判题会话自身不产 trace：不禁的话它会被采成 span，污染诊断面。
      const res = await runAgentCli({
        prompt: JUDGE_PROMPT,
        model: MODEL || undefined,
        cwd: pkg,
        captureTools: false,
        extraArgs: ["--settings", '{"disableAllHooks":true}', "--setting-sources", "project", "--disable-slash-commands"],
        timeoutMs: TIMEOUT_MS,
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
    if (imp.code !== 0) { console.error(`✗ 回流失败：${experiment}（包留在 ${pkg}）`); failN++; continue; }
    okN++; thisOk = true;
  } finally {
    if (!KEEP && thisOk) { try { fs.rmSync(pkg, { recursive: true, force: true }); } catch { /* */ } }
  }
}

console.error(`\n== 本轮判题：成 ${okN} 轮 · 败 ${failN} 轮 ==`);
process.exit(failN > 0 ? 1 : 0);
