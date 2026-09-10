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
//     --kind run    只列「没跑过诊断」的用例    → 喂给 loop ②
//     --kind judge  只列「跑过但没判」的诊断    → 喂给 loop ③
//     --kind both   两样都列（默认）
//     --json        出机器可读的 JSON（loop 脚本用这个）
//
// env：DBDOG_BASE_URL + DBDOG_API_KEY（或装 hooks 时配的 DBDOG_OBS_API_KEY）。
import { CP, call, requireCredential } from "./lib/exp-client.mjs";
import { resolveDatasetTraces } from "./lib/dataset-traces.mjs";

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

const needRun = [];
const needJudge = [];
for (const rec of records) {
  const runs = runsByRecord.get(rec.id) ?? [];
  const prompt = rec.input?.prompt ?? "";
  if (runs.length === 0) {
    needRun.push({ recordId: rec.id, prompt });
    continue;
  }
  for (const r of runs) {
    if (r.traceId && !judged.has(r.traceId)) {
      needJudge.push({ recordId: rec.id, prompt, traceId: r.traceId, experiment: r.experimentName });
    }
  }
}

if (JSON_OUT) {
  const out = {
    project: PROJECT, dataset: DATASET, dataset_version: dataset.current_version ?? null,
    total_records: records.length,
    ...(KIND !== "judge" ? { need_run: needRun } : {}),
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
  console.log(`\n没跑过诊断：${needRun.length} 条` + (needRun.length ? "" : "（都跑过了）"));
  for (const r of needRun) console.log(`  ${r.recordId}  ${one(r.prompt)}`);
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
    console.log(`\n  ↳ 判它们：把每条 trace 交给 agent 按 dbdog/llm-obs-diag-judge 判，`);
    console.log(`     判完用 judge-package-import.mjs 回流（或让 agent 直接写回）。`);
  }
}
}
