#!/usr/bin/env node
// training-corpus-export.mjs — 把判过的诊断 trace 导成训练语料（飞轮 P4「收口」，设计 §4 P4 行）。
//
// 为什么筛这一档（D4）：判题的第一层标签问的是「这条 trace 还能用来干什么」。
//   可信 ✅ + 要修 ❌ = 纯模型 + prompt 的行为样本，**不论对错都是样本**（owner：不同反应没有 true bug）；
//   可信 ✅ + 要修 ✅ = trace 还能用，但 dbdog 侧缺采集/接口 —— 要收就得知道它带着已知缺口（`--include-needs-fix`）；
//   可信 ❌ = dbdog 撒过谎，整条作废，不进训练集；
//   蒙对 ✅ = 对了没证据，学它就是学蒙，排除。
// 判据只认**服务端投影到 root span 上的 `evaluation.*` tag**（设计 §7.2）——分数是投影、批注是原件，
// 筛选走投影（能下推到 CH 检索），原件随样本一起带走（`judge` 字段）。
//
// 用法：
//   node scripts/llmobs/training-corpus-export.mjs --out <dir>
//     [--dataset <用例集名> [--project default-project]]
//     [--from <iso>] [--to <iso>] [--ml-app <x>] [--include-needs-fix] [--page-limit 1000]
//
//   --dataset：只导**这个用例集的题**跑出来的诊断（跑批跑出来的 + 题沉淀自的那次）。
//   不带它就是全库时间窗——owner 2026-09-10：「如果是全库它的命令就不该在某个用例集里面」，
//   所以控制台用例集页生成的命令一定带它。
//
// env 同 run-experiment（DBDOG_BASE_URL / DBDOG_API_KEY 或 DBDOG_INTERNAL_TOKEN / DBDOG_ORG）。
//
// 产物：
//   <dir>/corpus.jsonl    一条样本一行（形状见 lib/training-corpus.mjs 的 buildSample）
//   <dir>/manifest.json   选样条件 + 条数分布 + 生成时间 + server
import fs from "node:fs";
import path from "node:path";
import { baseUrl, getTrace, searchAllSpans, findAllAnnotationsByContent, requireCredential } from "./lib/exp-client.mjs";
import { resolveDatasetTraces } from "./lib/dataset-traces.mjs";
import { rootSpanOf } from "./lib/judge-package.mjs";
import { EVAL_TAG_KEYS, buildSample, flattenJudgeLabels, selectSample } from "./lib/training-corpus.mjs";

const argOf = (name, dflt) => {
  const i = process.argv.indexOf(name);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : dflt;
};
const has = (name) => process.argv.includes(name);
const fail = (m) => { console.error(`✗ ${m}`); process.exit(1); };

const OUT = argOf("--out", "");
const ML_APP = argOf("--ml-app", "");
const DATASET = argOf("--dataset", "");
const PROJECT = argOf("--project", "default-project");
const INCLUDE_NEEDS_FIX = has("--include-needs-fix");
const PAGE_LIMIT = Math.min(Math.max(Number(argOf("--page-limit", "1000")) || 1000, 1), 5000); // server 上限 5000

// 缺省窗 30 天：server 自己的兜底是近 24h（检索面的口径），对「攒一批语料」太窄——
// 但**不许让它隐式生效**，缺省也算进 manifest 的选样条件，回头才说得清这批是从哪个窗里捞的。
const isoOr = (v, fallbackMs) => {
  if (!v) return new Date(fallbackMs).toISOString();
  const t = Date.parse(v);
  if (Number.isNaN(t)) fail(`时间不是合法 ISO8601：${v}`);
  return new Date(t).toISOString();
};
const now = Date.now();
const TO = isoOr(argOf("--to", ""), now);
const FROM = isoOr(argOf("--from", ""), now - 30 * 24 * 3600 * 1000);

if (!OUT) fail("--out 必填");
requireCredential();
if (Date.parse(FROM) >= Date.parse(TO)) fail(`--from（${FROM}）不早于 --to（${TO}）`);

// ── 选样：服务端只筛「可信 ✅」，其余在客户端判 ────────────────────────────────
// 为什么不把 lucky_guess / needs_fix 也塞进请求的 tags：`tags` 是**等值 AND**（server
// `SearchSpans` 的 `tags[?] = ?`），只表达得了「等于」，表达不了「不等于 true」——
// 而「没判蒙对」的 trace 根本没有那个 tag 键，等值筛会连它一起筛掉。所以拉回来自己判，
// 顺便把每条被排除的理由计进分布（manifest 里说得清「为什么只剩这么点」）。
const query = {
  root_only: true,
  kind: "agent",
  tags: { [EVAL_TAG_KEYS.trustworthy]: "true" },
  from: FROM,
  to: TO,
  ...(ML_APP ? { ml_app: ML_APP } : {}),
};

console.error(`窗 ${FROM} → ${TO}${ML_APP ? `　ml_app=${ML_APP}` : ""}　${INCLUDE_NEEDS_FIX ? "含" : "不含"}要修 dbdog 的样本`);
const roots = await searchAllSpans(query, {
  limit: PAGE_LIMIT,
  onPage: (page, total) => console.error(`· 取回 ${page.length}（累计 ${total}）`),
});
console.error(`可信 ✅ 的 root span：${roots.length} 条`);

// ── 按用例集筛：只留这个集合的题跑出来的 trace ─────────────────────────────
// 在客户端筛而不是塞进 spans/search：trace↔题的线在 PG（records / events），spans 在 CH，
// server 没有跨这两边的检索口，而这条线 loop-pending 本来就在算（同一份 lib）。
let datasetScope = null;
if (DATASET) {
  try {
    datasetScope = await resolveDatasetTraces({ project: PROJECT, dataset: DATASET });
  } catch (e) {
    fail(e instanceof Error ? e.message : String(e));
  }
  const before = roots.length;
  for (let i = roots.length - 1; i >= 0; i--) {
    if (!datasetScope.traceIds.has(String(roots[i].trace_id ?? ""))) roots.splice(i, 1);
  }
  console.error(`用例集 ${DATASET}（${datasetScope.records.length} 条题、${datasetScope.traceIds.size} 次诊断）：${before} → ${roots.length} 条`);
}

const excluded = { not_trustworthy: 0, lucky_guess: 0, needs_fix: 0, needs_fix_unjudged: 0, no_trace: 0 };
const picked = [];
for (const root of roots) {
  const pick = selectSample(root, { includeNeedsFix: INCLUDE_NEEDS_FIX });
  if (!pick.keep) {
    excluded[pick.reason] = (excluded[pick.reason] ?? 0) + 1;
    continue;
  }
  picked.push({ root, sampleKind: pick.sample_kind });
}
console.error(`筛后：${picked.length} 条（排除 ${Object.entries(excluded).filter(([, n]) => n).map(([k, n]) => `${k}=${n}`).join("、") || "0"}）`);

// ── 批注原件：一次问全（分块 + 翻到底），别一条 trace 一个请求 ────────────────
const judgeByTrace = picked.length
  ? await findAllAnnotationsByContent(picked.map(({ root }) => String(root.trace_id)))
  : new Map();

// ── 逐条取整条 trace（假设树 / 总结 / 子代理数都要全量 span，检索只回 root）────
fs.mkdirSync(OUT, { recursive: true });
const rows = [];
const kinds = { model: 0, dbdog_gap: 0 };
for (const { root, sampleKind } of picked) {
  const traceId = String(root.trace_id ?? "");
  const trace = await getTrace(traceId);
  if (trace?.status === "not_found" || !(trace?.spans ?? []).length) {
    // 检索命中了 root，整条 trace 却查不到：不是「空样本」，是取数不一致，如实排除并计数。
    excluded.no_trace += 1;
    console.error(`· ${traceId.slice(0, 12)} 排除：trace 读口查不到 span`);
    continue;
  }
  const spans = trace.spans;
  const sample = buildSample({
    traceId,
    spans,
    // root 以 trace 读口的那条为准（检索页与 trace 读口同源，但 input/output 在这条上最全）；
    // 找不到就退回检索命中的那条，别整条丢掉。
    rootSpan: rootSpanOf(spans) ?? root,
    judge: flattenJudgeLabels(judgeByTrace.get(traceId)),
    sampleKind,
    mlApp: ML_APP || null,
  });
  kinds[sampleKind] += 1;
  rows.push(sample);
}

fs.writeFileSync(path.join(OUT, "corpus.jsonl"), rows.map((r) => JSON.stringify(r)).join("\n") + (rows.length ? "\n" : ""));

const manifest = {
  generated_at: new Date().toISOString(),
  server: baseUrl(),
  // 选样条件写全（含缺省值算出来的窗）：这批语料日后要能被原样复现出来。
  selection: {
    from: FROM, to: TO, ml_app: ML_APP || null,
    include_needs_fix: INCLUDE_NEEDS_FIX,
    server_query: query,
    client_filter: "evaluation.lucky_guess ≠ true，且 evaluation.needs_fix 判过（D4）",
    page_limit: PAGE_LIMIT,
  },
  counts: {
    root_spans_matched: roots.length,
    samples: rows.length,
    by_sample_kind: kinds,
    excluded,
    judged: rows.filter((r) => r.judge).length,
  },
};
fs.writeFileSync(path.join(OUT, "manifest.json"), JSON.stringify(manifest, null, 1));

console.log(`✓ 训练语料 ${rows.length} 条（model ${kinds.model} / dbdog_gap ${kinds.dbdog_gap}）→ ${path.resolve(OUT)}/corpus.jsonl；`
  + `窗 ${FROM}→${TO}，命中可信 root ${roots.length}，排除 ${Object.values(excluded).reduce((a, b) => a + b, 0)}`);
