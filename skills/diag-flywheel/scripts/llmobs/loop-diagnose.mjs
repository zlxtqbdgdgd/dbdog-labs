#!/usr/bin/env node
// loop-diagnose.mjs — 三条 loop 里的 ②：领一批待诊断的复现 → 逐条跑**盲**诊断。
//
// 它是**生产者**：只管把领到的复现跑出 trace 并推进到「待判题」，跑完就完。判题是 ③ 的活，
// 两条 loop 各跑各的节奏，谁挂了都不拖累另一条。
//
// ## 2026-09-11：从「每轮现算差集」改成「抢诊断表」
//
// 原来待跑集合是 loop-pending 算出来的差集「有复现、没 trace」。**那个算法没有在途这一档**：
// 本 loop 每 30 分钟一轮，而单条诊断的超时是 40 分钟，两轮必然重叠——第一轮还在跑，第二轮
// 去算差集，那条还没有 trace，于是被当成待跑又发一遍。同一次复现被诊断两遍，烧两份 agent
// 预算，还会在判题队列里留下两条互相矛盾的轨迹。整条链路上没有任何锁，这不是理论上的。
//
// 现在改成抢 `llmobs_case_diagnoses`（server 蓝图 pg/0025）：一行 = 一次复现，抢的动作本身
// 是原子的（server 那边是单条带 FOR UPDATE SKIP LOCKED 的 UPDATE），在途变成库里的一个态。
// ADR-0054「不预支复杂度」那条被这次推翻，理由就是上面这个实打实的重入。
//
// 用法：
// 待跑集合来自**诊断表**（一次复现一行）：抢到手即占住，别的轮次看不见。
// 没复现过的题根本不会出现在这张表里——现场不存在，发题只会让模型查一段空数据。
//
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
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnScript } from "./lib/spawn-script.mjs";
import { loadDataset } from "./lib/exp-client.mjs";
import {
  DIAG_DIAGNOSING,
  DIAG_PENDING,
  DIAG_PENDING_JUDGEMENT,
  advanceDiagnosis,
  claimBatch,
  listDiagnoses,
} from "./lib/case-diag-client.mjs";

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

// ---- ① 领：抢一批待诊断的复现 ----
// 抢到手即改成 diagnosing 并占住租约，于是下一轮（以及任何并发的一轮）都看不见它们了。
const CLAIMED_BY = argOf("--claimed-by", `loop-diagnose@${os.hostname()}`);
// 租约时长按**诊断超时 × 2** 取：给小了会把正在跑的那条抢走（两个进程诊断同一条），
// 给大了卡住的行要等更久才被捞回来。留一倍余量给收尾与上报。
const TIMEOUT_SEC = Number(argOf("--timeout-sec", "900")) || 900;
const STALE_AFTER_SEC = Number(argOf("--stale-after-sec", String(TIMEOUT_SEC * 2)));
const MAX_PER_ROUND = LIMIT > 0 ? LIMIT : Number(argOf("--max-per-round", "5"));

let claimed = [];
try {
  claimed = await claimBatch({ claimedBy: CLAIMED_BY, staleAfterSec: STALE_AFTER_SEC, max: MAX_PER_ROUND });
} catch (e) {
  fail(`抢诊断任务失败：${e.message || e}`);
}
if (ONLY.size) claimed = claimed.filter((d) => ONLY.has(String(d.record_id)));

// 抢占是**全局**的：诊断表上没有用例集这一维（一行只挂 record_id）。今天线上只有一个用例集，
// 咬不到；但多一个集合之后，本 loop 就可能抢走别的集合的行，而 run-experiment 按
// --dataset 装载记录、按 --scenarios 过滤，那条 record 根本不在这个集合里 ⇒ 跑不出 trace ⇒
// 被放回待诊断 ⇒ 下一轮再抢一次，空转到天荒地老。所以抢完先核归属，不是本集合的**立刻放回**。
// 根治要在 server 侧给 claim 加 dataset 过滤（表要么加列、要么 join records），那是另一条改动。
let foreign = 0;
if (claimed.length) {
  try {
    const { records: all } = await loadDataset({ projectName: PROJECT, datasetName: DATASET });
    const mine = new Set(all.map((r) => String(r.id)));
    const keep = [];
    for (const d of claimed) {
      if (mine.has(String(d.record_id))) { keep.push(d); continue; }
      foreign++;
      // 放回去，别攥着别的集合的活。放不回去也只是等租约，不阻断本轮。
      try {
        await advanceDiagnosis({ id: d.id, from: DIAG_DIAGNOSING, to: DIAG_PENDING, by: CLAIMED_BY });
      } catch { /* 等租约回收 */ }
    }
    claimed = keep;
    if (foreign) console.error(`· 放回 ${foreign} 条：它们不属于用例集 ${DATASET}（抢占目前是全局的）`);
  } catch (e) {
    console.error(`⚠ 核用例集归属失败，本轮按抢到的原样跑：${e.message || e}`);
  }
}

// 积压要报出来，哪怕本轮没抢到：数字悄悄变小很危险——不报，看到的人会以为「都跑完了」，
// 而真相可能是上游复现没跟上，或者一堆行卡在 diagnosing 等租约。
try {
  const backlog = await listDiagnoses({ statuses: [DIAG_PENDING], limit: 1000 });
  const inflight = await listDiagnoses({ statuses: [DIAG_DIAGNOSING], limit: 1000 });
  console.error(`· 队列：待诊断 ${backlog.length} 条 · 诊断中 ${inflight.length} 条（含本轮抢到的 ${claimed.length} 条）`);
} catch { /* 看板信息，拿不到不阻断本轮 */ }

if (claimed.length === 0) {
  console.error(`本轮无事：用例集 ${DATASET} 里没有待诊断的复现。`);
  process.exit(0);
}

// record → 它这次的诊断行。跑完按它推进状态。
const diagByRecord = new Map(claimed.map((d) => [String(d.record_id), d]));
const picked = claimed.map((d) => ({ recordId: String(d.record_id), prompt: d.case_source }));
console.error(`本轮领到 ${picked.length} 条：`);
for (const d of claimed) {
  console.error(`  ${d.case_source}  窗口 ${d.window_start} → ${d.window_end}  (${d.id.slice(0, 8)})`);
}

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
const resultFile = path.join(os.tmpdir(), `diag-loop-result-${process.pid}.json`);
args.push("--result-json", resultFile);
const ran = await spawnScript(HERE, "run-experiment.mjs", args);

// ---- ③ 推进：跑出 trace 的转「待判题」，没跑出来的**放回待诊断** ----
// 放回而不是留在 diagnosing：留着要等租约超时才被捞，那段时间里页面上显示「诊断中」，
// 是在骗人。放回之后下一轮会重试。
// ⚠️ 已知代价：一条**每次都失败**的用例会每 30 分钟重试一次，一直烧 agent 预算。
//    四态里没有「失败」这一档（owner 定的就是四态），要根治得加重试计数或第五态——
//    没有实测到这种用例之前不预支这个复杂度，先靠队列数字暴露它。
let results = [];
try {
  results = JSON.parse(fs.readFileSync(resultFile, "utf8"));
} catch {
  console.error(`⚠ 读不到本轮结果（${resultFile}）——所有领到的行放回待诊断，下轮重试`);
}
fs.rmSync(resultFile, { force: true });

const traceOf = new Map(results.map((r) => [String(r.recordId), r.traceId || ""]));
let advanced = 0, released = 0;
for (const [recordId, diag] of diagByRecord) {
  const traceId = traceOf.get(recordId) || "";
  const to = traceId ? DIAG_PENDING_JUDGEMENT : DIAG_PENDING;
  try {
    const row = await advanceDiagnosis({ id: diag.id, from: DIAG_DIAGNOSING, to, traceId, by: CLAIMED_BY });
    if (!row) {
      // 409：这条已经不在 diagnosing 了（租约被回收后别人重跑过）。本轮放弃它，不是错。
      console.error(`· ${diag.case_source} 的租约已易主，本轮不改它的状态`);
      continue;
    }
    if (traceId) advanced++; else released++;
  } catch (e) {
    console.error(`⚠ ${diag.case_source} 推进状态失败（下轮靠租约回收）：${e.message || e}`);
  }
}
console.error(`· 状态推进：${advanced} 条 → 待判题，${released} 条没拿到 trace 已放回待诊断`);
process.exit(ran.code ?? 0);
