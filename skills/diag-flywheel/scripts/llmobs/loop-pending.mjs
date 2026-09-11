#!/usr/bin/env node
// loop-pending.mjs — 三条 loop 的「有没有新增要处理的」检测（飞轮 §12 / 控制台 §6c）。
//
// 同事把评测跑成三条自动化 loop（owner 2026-09-10）：
//   ① 爬 QA → 建用例（REST 直接提交，不需要本脚本）
//   ② 检测新增用例 → 逐条跑**盲**诊断
//   ③ 检测新增诊断 → 判题
// ②③ 的第一步都是「哪些还没轮到我」，这就是本脚本。
//
// 为什么是客户端算而不是服务端加接口：这个判定要跨 PG（records）与 CH（events/spans），
// 服务端做要开一条新的联查路由；而客户端三跳就够，慢的是 events 那一跳（一个 run 一次请求）。
// 等真慢到不能忍再上服务端，不预支复杂度（ADR-0054 末尾也这么登记了）。
//
// 用法：
//   node scripts/llmobs/loop-pending.mjs --dataset daily-diag [--project default-project]
//     [--kind run|judge|both] [--json]
//
//     --kind run    只列「复现过、但还没诊断」的用例 → 喂给 loop ②
//                   （没复现过的另列一桶 waiting_repro：现场不存在，发题只会空转）
//     --kind judge  只列「跑过但没判」的诊断    → 喂给 loop ③
//     --kind both   两样都列（默认）
//     --json        出机器可读的 JSON（loop 脚本用这个）
//
// env：DBDOG_BASE_URL + DBDOG_API_KEY（或装 hooks 时配的 DBDOG_OBS_API_KEY）。
import { CP, call, requireCredential } from "./lib/exp-client.mjs";
import { resolveDatasetTraces } from "./lib/dataset-traces.mjs";
import { windowClause } from "./lib/case-window.mjs";

const argOf = (n, d) => { const i = process.argv.indexOf(n); return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : d; };
const has = (n) => process.argv.includes(n);
const fail = (m) => { console.error(`✗ ${m}`); process.exit(1); };

const PROJECT = argOf("--project", "default-project");
const DATASET = argOf("--dataset", "");
const KIND = argOf("--kind", "both");
const JSON_OUT = has("--json");
if (!DATASET) fail("--dataset 必填");
if (!["run", "judge", "both"].includes(KIND)) fail(`--kind 只能是 run|judge|both，收到 ${KIND}`);
requireCredential();

// 用例集 → 题 → 历次诊断，解析线单源在 lib/dataset-traces.mjs（导语料按集合筛也用它）
let resolved;
try {
  resolved = await resolveDatasetTraces({ project: PROJECT, dataset: DATASET });
} catch (e) {
  fail(e instanceof Error ? e.message : String(e));
}
const { project, dataset, records, runsByRecord } = resolved;

// 判过没有：判题结果由 server 投影到 root span 的 `evaluation.*` tag（P2/ADR-0051），
// 所以问 spans 就够，不用回头翻 annotation 原件。
const judged = new Set();
if (KIND !== "run") {
  const traceIds = [...runsByRecord.values()].flat().map((r) => r.traceId).filter(Boolean);
  if (traceIds.length > 0) {
    const res = await call("POST", "/api/v2/llmobs/spans/search", {
      root_only: true, kind: "agent", limit: 1000,
      from: new Date(Date.now() - 180 * 86400 * 1000).toISOString(),
      to: new Date().toISOString(),
    });
    for (const s of res?.spans ?? []) {
      const v = s.tags?.["evaluation.verdict"];
      if (v) judged.add(s.trace_id);
    }
  }
}

// 「能跑」不等于「没跑过」：还要现场真的存在过。复现那一步会把实例与时间窗写进
// `metadata.repro`（case-window.mjs 用的是同一格）。没有这一格，说明这道题从没在靶机上
// 复现，遥测里压根没有对应时段的数据——发出去只会让模型查一段空数据，空转出来的 trace
// 还会顺着差集流进判题队列。所以没复现的不进待跑集合，但也**不静默扣着**，单列一桶报出来。
const needRun = [];
const waitingRepro = [];
const needJudge = [];
const metaOf = (rec) => rec.attributes?.metadata ?? rec.metadata ?? {};
for (const rec of records) {
  const runs = runsByRecord.get(rec.id) ?? [];
  const prompt = rec.input?.prompt ?? "";
  if (runs.length === 0) {
    const repro = metaOf(rec).repro;
    // 半截窗口（只有起或只有止）不是「没复现」，是那条复现记录坏了——分开报，
    // 否则它会混在几百条「等复现」里，没人会去修它。
    const reason = !repro ? "no_repro" : (windowClause(repro) ? "" : "incomplete_window");
    if (reason) waitingRepro.push({ recordId: rec.id, prompt, reason });
    else needRun.push({ recordId: rec.id, prompt, repro });
    continue;
  }
  for (const r of runs) {
    if (r.traceId && !judged.has(r.traceId)) {
      // eventId 一并给出：判题包按 event id 挑子集（judge-package-export --cases），
      // 一例一个包一个会话，材料量和失败影响面都只算这一例。
      needJudge.push({ recordId: rec.id, prompt, traceId: r.traceId, experiment: r.experimentName, eventId: r.eventId });
    }
  }
}

if (JSON_OUT) {
  const out = {
    project: PROJECT, dataset: DATASET, dataset_version: dataset.current_version ?? null,
    total_records: records.length,
    ...(KIND !== "judge" ? { need_run: needRun, waiting_repro: waitingRepro } : {}),
    ...(KIND !== "run" ? { need_judge: needJudge } : {}),
  };
  // 写完**不要** process.exit：往管道写是异步的，exit 不等它刷完，后半截直接丢
  // （2026-09-10 实测：105KB 被截到 41KB，报出来长得像上游数据坏了）。
  // 重定向到文件看不出来——文件写是同步的。让脚本自然结束即可。
  console.log(JSON.stringify(out, null, 1));
} else {

const one = (s, n = 56) => String(s).replace(/\s+/g, " ").trim().slice(0, n);
console.log(`用例集 ${DATASET}（${records.length} 条用例）`);
if (KIND !== "judge") {
  console.log(`\n复现过、还没诊断：${needRun.length} 条` + (needRun.length ? "" : "（没有）"));
  for (const r of needRun) console.log(`  ${r.recordId}  ${one(r.prompt)}`);
  if (waitingRepro.length) {
    const broken = waitingRepro.filter((r) => r.reason === "incomplete_window");
    console.log(`\n等复现（现场还不存在，不发题）：${waitingRepro.length} 条`);
    if (broken.length) {
      console.log(`  其中 ${broken.length} 条是复现记录坏了（只有半截时间窗），要回头修那条记录：`);
      for (const r of broken) console.log(`    ${r.recordId}  ${one(r.prompt)}`);
    }
  }
  if (needRun.length) {
    console.log(`\n  ↳ 跑它们（拉题走盲视图，agent 看不到答案）：`);
    console.log(`     GET ${CP}/${project.id}/datasets/${dataset.id}/records?filter[view]=blind`);
    console.log(`     node scripts/llmobs/run-experiment.mjs --experiment <本轮名字> --scenarios <上面的 record id>`);
  }
}
if (KIND !== "run") {
  console.log(`\n跑过但没判：${needJudge.length} 条` + (needJudge.length ? "" : "（都判过了）"));
  for (const r of needJudge) console.log(`  ${r.traceId}  ${one(r.prompt)}`);
  if (needJudge.length) {
    console.log(`\n  ↳ 判它们：把每条 trace 交给 agent 按 dbdog/diag-judge（插件 dbdog-agent-obs） 判，`);
    console.log(`     判完用 judge-package-import.mjs 回流（或让 agent 直接写回）。`);
  }
}
}
