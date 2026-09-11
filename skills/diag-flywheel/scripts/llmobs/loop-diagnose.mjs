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
//     [--limit N] [--only <record id,...>] [--model M] [--timeout-sec 900] [--concurrency 3]
//     [--experiment <本轮名字>] [--dry-run]
//     # 盲测评测那条路再加四个（真实用户用不上，见 run-experiment.mjs 用法段）：
//     [--workdir <被诊断系统源码树>] [--deny-root <禁读根>]... [--guard-hook <命令行>]
//
// env 同 run-experiment（DBDOG_BASE_URL + DBDOG_API_KEY）。
//
// 并发默认 3（owner 2026-09-11 定）。原来固定传 1，理由是「本机多个 claude 进程会抢登录态」
// ——那条实测记在 `run-experiment.mjs` 的 --concurrency 注释里。放到 3 是在这个风险与一轮的
// 墙钟之间取的折中：一条诊断动辄二三十分钟，五条串起来就是两小时，队列根本消不掉。
// 那次实测撞的是本机共享的 OAuth 登录态；考生现在走 DeepSeek 的 API token
// （`ANTHROPIC_AUTH_TOKEN`，见 use_candidate_env），没有这份共享状态可抢。真撞上了
// （表现是某条一开跑就报鉴权失败、exit=1 且 stderr 是空的），传 --concurrency 1 退回串行。
//
// 同一道题（record）在诊断表里可能有多次复现，各自一行。**一轮只跑最新那次**（owner 同日定）：
// 同题在一轮里诊断两遍，除了烧两份 agent 预算，还会在判题队列里留下两条几乎一样的轨迹；
// 而旧那次复现的现场早被新那次盖过去了，遥测窗口指向的东西已经不是它。
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
  claimDiagnosis,
  operator,
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
// 报上跑的人是谁（DBDOG_OPERATOR）。**在抢任何东西之前就查**：抢到手的行会被改成 diagnosing
// 占住租约，等跑到推状态那一步才发现缺这个变量，那批行就得等租约超时才被捞回来。
try { operator(); } catch (e) { fail(e.message); }

// ---- ① 领：抢一批待诊断的复现 ----
// 抢到手即改成 diagnosing 并占住租约，于是下一轮（以及任何并发的一轮）都看不见它们了。
const CLAIMED_BY = argOf("--claimed-by", `loop-diagnose@${os.hostname()}`);
// 租约时长按**诊断超时 × 2** 取：给小了会把正在跑的那条抢走（两个进程诊断同一条），
// 给大了卡住的行要等更久才被捞回来。留一倍余量给收尾与上报。
const TIMEOUT_SEC = Number(argOf("--timeout-sec", "900")) || 900;
const STALE_AFTER_SEC = Number(argOf("--stale-after-sec", String(TIMEOUT_SEC * 2)));
const MAX_PER_ROUND = LIMIT > 0 ? LIMIT : Number(argOf("--max-per-round", "5"));
// 并发默认 3（见文件头）。给 0 或负数没有意义，兜回 1。
const CONCURRENCY = Math.max(1, Number(argOf("--concurrency", "3")) || 3);

// 「同题只跑最新那次复现」要在**抢之前**先有一张快照才判得出来：抢的动作会把行改成
// diagnosing，之后再去列 pending 就看不见同题的兄弟行了。快照拿不到就不筛——宁可这一轮
// 多跑一条重复的，也不要因为看板接口抽风而整轮不跑。
let latestPerRecord = null;
let pendingCount = 0;
try {
  const pending = await listDiagnoses({ statuses: [DIAG_PENDING], limit: 1000 });
  pendingCount = pending.length;
  latestPerRecord = new Map();
  for (const d of pending) {
    const k = String(d.record_id);
    const cur = latestPerRecord.get(k);
    // 「最新」按复现窗口的结束时间排，同刻再用行 id 兜底（要的是一个稳定的选法，不是并列）。
    if (!cur || String(d.window_end) > String(cur.window_end) ||
        (String(d.window_end) === String(cur.window_end) && String(d.id) > String(cur.id))) {
      latestPerRecord.set(k, d);
    }
  }
} catch (e) {
  console.error(`⚠ 列不出待诊断队列，本轮不做「同题只跑最新」的筛选：${e.message || e}`);
}

// ⚠️ 抢到旧复现**不能当场放回**：server 的 claim 是 `ORDER BY created_at, id LIMIT 1`——
// 永远先给最旧的那条。放回去下一次抢到的还是它，五十次尝试全花在同几条上，最新那次一次
// 也轮不到（2026-09-11 实测：跳过 50 条、领到 0 条，整轮空转）。
// 所以改成**攥着翻页**：抢到的旧复现先扣在手里（它们此刻是 diagnosing，不会被别人再抢到），
// 一直翻到该题最新那次为止，本轮凑够数了再把扣着的一次性放回待诊断。
//
// 代价是每轮都要把比「最新那次」旧的行重抢一遍，队列越长越费。根治要 server 那边让 claim
// 能按行 id 领（现在只能按 created_at 拿最旧的），或者给作废的旧复现一个归档终态——
// 四态里没有这一档，先不预支，靠日志里「扣了几条」暴露它涨没涨。
let claimed = [];
const parked = [];          // 攥在手里的旧复现，本轮末尾统一放回
const seenRecords = new Set();
// 上限按队列长度给：最坏情况要把比 latest 旧的行全翻一遍才够数。
const MAX_ATTEMPTS = (latestPerRecord ? pendingCount : 0) + MAX_PER_ROUND * 2 + 10;
try {
  for (let attempt = 0; claimed.length < MAX_PER_ROUND && attempt < MAX_ATTEMPTS; attempt++) {
    const row = await claimDiagnosis({ claimedBy: CLAIMED_BY, staleAfterSec: STALE_AFTER_SEC });
    if (!row) break; // 没得抢了
    const key = String(row.record_id);
    const latest = latestPerRecord?.get(key);
    const isLatest = !latest || String(latest.id) === String(row.id);
    if (isLatest && !seenRecords.has(key)) {
      seenRecords.add(key);
      claimed.push(row);
    } else {
      parked.push(row);
    }
  }
} catch (e) {
  fail(`抢诊断任务失败：${e.message || e}`);
}
// 放回扣着的：留在 diagnosing 的话页面上它一直显示「诊断中」，是在骗人。
let released0 = 0;
for (const row of parked) {
  try {
    if (await advanceDiagnosis({ id: row.id, from: DIAG_DIAGNOSING, to: DIAG_PENDING })) released0++;
  } catch { /* 放不回去也只是等租约，不阻断本轮 */ }
}
if (parked.length) {
  console.error(`· 翻过 ${parked.length} 条同题的旧复现（一轮只跑每道题最新那次），已放回 ${released0} 条`);
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
        await advanceDiagnosis({ id: d.id, from: DIAG_DIAGNOSING, to: DIAG_PENDING });
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

// 按**行**记，不按 record 记。原来这里是 `new Map(claimed.map(d => [record_id, d]))`，
// 同一道题抢到两行时后一行会把前一行挤掉——被挤掉的那行既不推进也不放回，只能干等租约
// 回收，而页面上它一直显示「诊断中」。现在同题只会抢到一行，这个索引照样按行建：
// 不靠「上游保证唯一」来维持下游的正确性。
const claimedRows = claimed.slice();
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

// `--diagnosis rec=diagId`：告诉 run-experiment 每条 record 跑的是**哪一行诊断**，好让它
// 一落完实验事件就当场把 trace 写回去，不必等这一轮跑完（owner 2026-09-11）。
// 显式传而不是让它自己查：同一道题可能有多行复现，现查只能猜一个，猜错就把 trace 记到
// 另一次复现头上，而页面上看不出来。
const diagPairs = claimedRows.map((d) => `${String(d.record_id)}=${d.id}`).join(",");

const args = [
  "--project", PROJECT, "--dataset", DATASET,
  "--experiment", EXPERIMENT,
  "--scenarios", picked.map((r) => r.recordId).join(","),
  ...(diagPairs ? ["--diagnosis", diagPairs] : []),
  "--concurrency", String(CONCURRENCY),
  ...passthrough,
];
console.error(`\n▶ 本轮 experiment：${EXPERIMENT}（${picked.length} 条 · 并发 ${CONCURRENCY}）\n`);
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

// **这一段现在是兜底，不是主路**：跑出 trace 的那些，run-experiment 落事件时就已经当场
// 推到「待判题」了（它那一刻同时握着 record 与 trace，写在那儿才不怕本进程被掐）。
// 这里还留着，是为了两种它没覆盖到的情况：
//   · 一条都没跑出 trace ⇒ 要放回待诊断，那是本段独有的活；
//   · run-experiment 那次回填没打通（网络抖、server 500）⇒ 再补一次。
// 于是 409 从此变成**常态**：多半是「已经提前登记过了」，不再是「租约易主」。两者对本轮是
// 同一个动作（什么都不用做），但日志不能只写后者——那会让人以为出了竞争。
const traceOf = new Map(results.map((r) => [String(r.recordId), r.traceId || ""]));
let advanced = 0, released = 0, already = 0;
for (const diag of claimedRows) {
  const traceId = traceOf.get(String(diag.record_id)) || "";
  const to = traceId ? DIAG_PENDING_JUDGEMENT : DIAG_PENDING;
  try {
    const row = await advanceDiagnosis({ id: diag.id, from: DIAG_DIAGNOSING, to, traceId });
    if (!row) {
      if (traceId) already++;   // 几乎总是 run-experiment 已经登记过了
      else console.error(`· ${diag.case_source} 的租约已易主，本轮不改它的状态`);
      continue;
    }
    if (traceId) advanced++; else released++;
  } catch (e) {
    console.error(`⚠ ${diag.case_source} 推进状态失败（下轮靠租约回收）：${e.message || e}`);
  }
}
if (already) console.error(`· ${already} 条在跑完时就已登记为待判题（run-experiment 当场回填），本段不用再推`);
console.error(`· 状态推进：${advanced + already} 条 → 待判题（其中 ${already} 条跑完时已登记），${released} 条没拿到 trace 已放回待诊断`);
process.exit(ran.code ?? 0);
