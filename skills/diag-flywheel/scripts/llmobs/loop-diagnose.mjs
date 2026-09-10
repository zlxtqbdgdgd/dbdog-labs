#!/usr/bin/env node
// loop-diagnose.mjs — 三条 loop 里的 ②：检测新增用例 → 逐条跑**盲**诊断。
//
// 它是**生产者**：只管把没诊断过的用例跑出 trace，跑完就完。判题是 ③ 的活，两条 loop
// 各跑各的节奏，中间不架队列——「跑过但没判过」这个差集每轮现算（ADR-0054 末尾：
// 不预支复杂度）。谁挂了都不拖累另一条。
//
// 用法：
//   node scripts/llmobs/loop-diagnose.mjs --dataset <用例集> [--project default-project]
//     [--limit N] [--only <record id,...>] [--model M] [--timeout-sec 900]
//     [--experiment <本轮名字>] [--dry-run]
//     # 盲测评测那条路再加四个（真实用户用不上，见 run-experiment.mjs 用法段）：
//     [--workdir <被诊断系统源码树>] [--deny-root <禁读根>]... [--guard-hook <命令行>]
//
// env 同 run-experiment（DBDOG_BASE_URL + DBDOG_API_KEY）。
//
// 串行是硬要求，不是保守：本机多个 claude 进程并发会抢登录态，且判题也是 claude 进程
// （`run-experiment.mjs` 的 --concurrency 注释记着实测）。这里固定传 --concurrency 1。
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnScript } from "./lib/spawn-script.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const argOf = (n, d) => { const i = process.argv.indexOf(n); return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : d; };
const argsOf = (n) => { const o = []; for (let i = 0; i < process.argv.length; i++) if (process.argv[i] === n && process.argv[i + 1]) o.push(process.argv[i + 1]); return o; };
const has = (n) => process.argv.includes(n);
const fail = (m) => { console.error(`✗ ${m}`); process.exit(1); };

const PROJECT = argOf("--project", "default-project");
const DATASET = argOf("--dataset", "");
const LIMIT = Number(argOf("--limit", "0"));
// --only：只跑指定的几条（与待跑集合取交集）。子集跑批是有代价的——D7/D8：只跑了一部分时
// 不许说总分，页面会印「覆盖 N/M，非全量」。给了 --only 就把「为什么选这些」记进 run 备注。
const ONLY = new Set(argOf("--only", "").split(",").map((s) => s.trim()).filter(Boolean));
const DRY = has("--dry-run");
if (!DATASET) fail("--dataset 必填");

// ---- ① 捞：哪些用例还没诊断过 ----
// 检测逻辑不在这里重写一遍——单源在 loop-pending.mjs（军规 3）。
const pending = await spawnScript(HERE, "loop-pending.mjs", ["--project", PROJECT, "--dataset", DATASET, "--kind", "run", "--json"], { capture: true });
if (pending.code !== 0) fail("loop-pending 失败（上面是它的输出）");
let needRun;
try { needRun = JSON.parse(pending.out).need_run ?? []; } catch { fail(`loop-pending 的 JSON 解析不了：${pending.out.slice(0, 200)}`); }

if (needRun.length === 0) {
  console.error(`本轮无事：用例集 ${DATASET} 里没有还没诊断过的用例。`);
  process.exit(0);
}

let picked = ONLY.size ? needRun.filter((r) => ONLY.has(String(r.recordId))) : needRun;
if (ONLY.size) {
  const missing = [...ONLY].filter((id) => !needRun.some((r) => String(r.recordId) === id));
  // 挑中的不在待跑集合里，多半是它已经诊断过了——照实说，别静默少跑一条。
  if (missing.length) console.error(`⚠ --only 里这 ${missing.length} 条不在待跑集合（多半已诊断过）：${missing.join(", ")}`);
  if (!picked.length) { console.error("✗ --only 指定的都不在待跑集合，本轮无事"); process.exit(0); }
}
picked = LIMIT > 0 ? picked.slice(0, LIMIT) : picked;
console.error(`待诊断 ${needRun.length} 条，本轮跑 ${picked.length} 条${picked.length < needRun.length ? "（子集，不许拿它说总分）" : ""}：`);
for (const r of picked) console.error(`  ${r.recordId}  ${String(r.prompt).replace(/\s+/g, " ").trim().slice(0, 56)}`);

// ---- ② 跑：一轮 = 一个 experiment，里面逐条串行 ----
// 一轮一个 run 而不是一条一个：D7「run 里有哪些 event 就是哪些用例」，重测挂 --parent 才有对照物。
const pad = (n) => String(n).padStart(2, "0");
const now = new Date();
const EXPERIMENT = argOf("--experiment", `diag-loop-${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}`);

const passthrough = [];
for (const n of ["--notes", "--model", "--timeout-sec", "--ml-app", "--prompt-source", "--workdir", "--guard-hook", "--judge-model"]) {
  const v = argOf(n, ""); if (v) passthrough.push(n, v);
}
for (const v of argsOf("--deny-root")) passthrough.push("--deny-root", v);
if (DRY) passthrough.push("--dry-run");

const args = [
  "--project", PROJECT, "--dataset", DATASET,
  "--experiment", EXPERIMENT,
  "--scenarios", picked.map((r) => r.recordId).join(","),
  "--concurrency", "1",
  ...passthrough,
];
console.error(`\n▶ 本轮 experiment：${EXPERIMENT}（串行 ${picked.length} 条）\n`);
const ran = await spawnScript(HERE, "run-experiment.mjs", args);
process.exit(ran.code ?? 0);
