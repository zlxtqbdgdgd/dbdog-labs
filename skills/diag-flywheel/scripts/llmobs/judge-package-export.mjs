#!/usr/bin/env node
// judge-package-export.mjs — 一轮实验导出成一个**自包含判题包**（飞轮 P2，设计 §7.3）。
//
// 为什么是「包」：判题模型在蓝区，蓝区没有 dbdog、连不上 server，只能靠人搬文件；
// 判题方**不能回头追问**，所以材料必须一次给全（D2 四件套：正向假设树 + 反向证据链 + 答案纸 + 探针结果）。
// 取数判题（能连 server 时现取）与包判题只差材料来源，判据、产物形状完全相同。
//
// 用法：
//   node scripts/llmobs/judge-package-export.mjs --experiment <uuid|run 名|逻辑名> --out <dir> [--cases a,b]
//     [--project default-project] [--dataset <name>] [--judge-model <名>] [--force-relabel]
//
// env 同 run-experiment（DBDOG_BASE_URL / DBDOG_API_KEY 或 DBDOG_INTERNAL_TOKEN / DBDOG_ORG）。
//
// 产物：
//   <dir>/manifest.json                 experiment `{id,name}`（id = 控制面 uuid，import 按它 PATCH 总账）/
//                                       label schema（**含 id**）/ 每例 event_id·trace_id·record_id·版本章
//   <dir>/skill/SKILL.md + README.md    判题 skill 正文 + 蓝区离线怎么跑
//   <dir>/cases/<event_id>/trace.json   server 导出原样
//                        /forward.md    正向假设树 + 工具调用 + 结论
//                        /reverse.md|.json  反向证据链（record.metadata.reverse_chain；缺则不产）
//                        /ground-truth.md   答案纸（expected_output；缺则不产 = 无参照题）
//                        /probe.json    探针结果（由 probe.mjs 写；已有则原样保留）
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  baseUrl, findProject, loadDataset,
  listAnnotationQueues, upsertAnnotationQueue, listAnnotationLabels, replaceAnnotationLabels,
  addAnnotationInteractions, listAllExperimentEvents, getExperimentEvent, getTrace,
  resolveExperimentRef,
  requireCredential,
} from "./lib/exp-client.mjs";
import {
  LABEL_SCHEMA, QUEUE_NAME, renderForward, renderReverse, renderGroundTruth,
  hasGroundTruth, rootSpanOf, stampOf,
} from "./lib/judge-package.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const argOf = (name, dflt) => {
  const i = process.argv.indexOf(name);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : dflt;
};
const has = (name) => process.argv.includes(name);
const fail = (m) => { console.error(`✗ ${m}`); process.exit(1); };

const EXPERIMENT = argOf("--experiment", "");
const OUT = argOf("--out", "");
const CASES = argOf("--cases", "").split(",").map((s) => s.trim()).filter(Boolean);
const PROJECT = argOf("--project", "default-project");
const DATASET = argOf("--dataset", "");
const JUDGE_MODEL = argOf("--judge-model", "");
const FORCE_RELABEL = has("--force-relabel");

if (!EXPERIMENT) fail("--experiment 必填");
if (!OUT) fail("--out 必填");
requireCredential();

/**
 * 队列与 label schema：**已有 label 一律读回 id 复用，不重发 PUT。**
 *
 * 取证（server `internal/storage/postgres/llmobs_annotation_store.go` 的
 * ReplaceAnnotationLabelSchemas）：整份替换是一个事务里的「DELETE 全部 label + 重插」，
 * 而 `llmobs_annotations.label_id` 是 ON DELETE CASCADE——**带不带原 id 都一样**，
 * DELETE 那一步已经把该队列的全部 annotation 连带删了，事后用同一个 id 插回来也救不回来。
 * 所以只有两种情形允许 PUT：队列刚建（还没有 label），或人明确 --force-relabel（会丢批注）。
 */
async function ensureQueue(projectID) {
  const queues = await listAnnotationQueues({ projectID });
  let queue = queues.find((q) => q.name === QUEUE_NAME) ?? null;
  if (!queue) {
    const created = await upsertAnnotationQueue({ name: QUEUE_NAME, projectID });
    queue = { queue_id: created.queue_id, name: created.name, project_id: created.project_id };
    console.error(`队列新建：${QUEUE_NAME} (${queue.queue_id})`);
  }
  const queueID = queue.queue_id ?? queue.id;
  let labels = await listAnnotationLabels(queueID);
  const wanted = LABEL_SCHEMA.map(({ label, value_type, options }, i) => ({
    label, value_type, ...(options ? { options } : {}), position: i,
  }));
  if (labels.length === 0) {
    labels = await replaceAnnotationLabels(queueID, wanted);
    console.error(`label schema 首次写入：${labels.length} 条`);
  } else if (FORCE_RELABEL) {
    console.error("⚠ --force-relabel：整份替换 label schema，该队列**已有的批注会被级联删光**");
    labels = await replaceAnnotationLabels(queueID, wanted);
  } else {
    const have = new Set(labels.map((l) => l.label));
    const missing = LABEL_SCHEMA.map((l) => l.label).filter((l) => !have.has(l));
    if (missing.length) {
      console.error(`⚠ 队列已有 label，但缺 ${missing.join(", ")}——**不重发 PUT**（会删光已有批注）。`);
      console.error("  这几项本轮判不了；要补齐得另起队列名，或人确认可丢批注后加 --force-relabel。");
    }
  }
  return { queueID, labels };
}

/** 反向链的来源：用例 record 的 `metadata.reverse_chain`（用例级资产，一条用例只生成一次）。 */
async function loadRecords(datasetName) {
  if (!datasetName) return { records: new Map(), reason: "未知 dataset（event 的 dimensions 里没有 dataset，也没给 --dataset）" };
  try {
    const { records } = await loadDataset({ projectName: PROJECT, datasetName });
    return { records: new Map(records.map((r) => [r.id, r])), reason: "" };
  } catch (e) {
    return { records: new Map(), reason: `dataset ${datasetName} 读不到：${e.message || e}` };
  }
}

// ── 主流程 ────────────────────────────────────────────────────────────────────
const project = await findProject(PROJECT);
if (!project?.id) fail(`project 不存在：${PROJECT}`);

// 先把 --experiment 定位到控制面那一行：**包认 uuid**（events_key = id::text，事件也按它取），
// 这样 import 回来能直接 PATCH 到 run 上。定位不到就停——总账没有落点的包是死包。
const run = await resolveExperimentRef(EXPERIMENT, { projectID: project.id });
if (!run?.id) {
  fail(`控制面里找不到 experiment ${EXPERIMENT}（--experiment 收 uuid / run 名 / 逻辑名）。`
    + "P3 起 runner 先建行后跑批；更早的 run 要等 server 启动期回填出行才找得到。");
}
const allEvents = await listAllExperimentEvents(run.id);
if (!allEvents.length) fail(`experiment ${run.name ?? run.id} 没有 event（跑批还没写进来？）`);
const events = CASES.length ? allEvents.filter((e) => CASES.includes(e.id)) : allEvents;
if (!events.length) fail(`--cases 过滤后没有 event（有的是：${allEvents.map((e) => e.id).join(", ")}）`);

const datasetName = DATASET || events.map((e) => e.dimensions?.dataset).find(Boolean) || "";
const { records, reason: recordsReason } = await loadRecords(datasetName);
if (recordsReason) console.error(`⚠ 反向证据链本轮全缺：${recordsReason}`);

const { queueID, labels } = await ensureQueue(project.id);

fs.mkdirSync(path.join(OUT, "cases"), { recursive: true });
fs.mkdirSync(path.join(OUT, "skill"), { recursive: true });

const cases = [];
for (const summary of events) {
  const eventID = summary.id;
  const caseDir = path.join(OUT, "cases", eventID);
  fs.mkdirSync(caseDir, { recursive: true });
  const missing = [];

  const event = await getExperimentEvent(run.id, eventID);
  const traceID = event?.trace_id || summary.trace_id || "";
  let spans = [];
  if (traceID) {
    const trace = await getTrace(traceID);
    if (trace?.status === "not_found") missing.push("trace（server 里查不到这条 trace）");
    else {
      spans = trace?.spans ?? [];
      fs.writeFileSync(path.join(caseDir, "trace.json"), JSON.stringify(trace, null, 1));
    }
  } else {
    missing.push("trace（event 没有 trace_id——那次跑批 hooks 没生效或超时被杀）");
  }

  fs.writeFileSync(path.join(caseDir, "forward.md"), renderForward(spans, { eventId: eventID, traceId: traceID }));

  const recordID = event?.dataset_record_id || summary.dataset_record_id || "";
  const record = records.get(recordID);
  const chain = record?.metadata?.reverse_chain;
  if (chain) {
    fs.writeFileSync(path.join(caseDir, "reverse.json"), JSON.stringify(chain, null, 1));
    fs.writeFileSync(path.join(caseDir, "reverse.md"), renderReverse(chain, { recordId: recordID }));
  } else {
    missing.push(`reverse（${recordsReason || `record ${recordID || "?"} 的 metadata.reverse_chain 为空`}）`);
  }

  const expected = event?.expected_output;
  if (hasGroundTruth(expected)) {
    fs.writeFileSync(path.join(caseDir, "ground-truth.md"), renderGroundTruth(expected, { eventId: eventID }));
  } else {
    missing.push("ground-truth（无参照题：expected_output 整个缺）");
  }

  // 探针结果由 probe.mjs 写进本目录；重跑 export 不覆盖已有的那份。
  const probePath = path.join(caseDir, "probe.json");
  if (!fs.existsSync(probePath)) missing.push("probe（探针还没跑：node scripts/llmobs/probe.mjs --case <本目录>）");

  cases.push({
    event_id: eventID,
    trace_id: traceID,
    record_id: recordID,
    status: event?.status ?? summary.status ?? "",
    stamp: stampOf(rootSpanOf(spans)),
    span_count: spans.length,
    missing,
  });
  console.error(`· ${eventID} trace=${traceID.slice(0, 8) || "—"} span=${spans.length}${missing.length ? ` 缺：${missing.length}` : ""}`);
}

// 排队（content_id = trace_id，content_kind = trace）。幂等，重跑无害；
// import 还会再排一次，为的是拿回 interaction id——两处都排不是重复，是各自都不依赖对方跑过。
const queued = cases.filter((c) => c.trace_id);
if (queued.length) {
  await addAnnotationInteractions(queueID, queued.map((c) => ({ content_id: c.trace_id, content_kind: "trace" })));
}

const manifest = {
  generated_at: new Date().toISOString(),
  server: baseUrl(),
  project: { id: project.id, name: PROJECT },
  dataset: datasetName || null,
  experiment: { id: run.id, name: run.name ?? EXPERIMENT },
  queue: { id: queueID, name: QUEUE_NAME },
  // label id 是这个包的一等资产：回写时按它认 label，**永不重发 PUT labels**（重发 = 删光批注）。
  label_schema: labels.map((l) => ({
    id: l.id, label: l.label, value_type: l.value_type,
    ...(l.options ? { options: l.options } : {}), position: l.position,
    display: LABEL_SCHEMA.find((s) => s.label === l.label)?.display ?? "",
  })),
  judge_model: JUDGE_MODEL || null,
  cases,
};
fs.writeFileSync(path.join(OUT, "manifest.json"), JSON.stringify(manifest, null, 1));

// 判题 skill 正文随包走（蓝区没有 MCP，读不到 Resource）。
fs.copyFileSync(
  path.join(ROOT, "src", "skillsets", "llmobs", "llm-obs-diag-judge", "SKILL.md"),
  path.join(OUT, "skill", "SKILL.md"),
);
fs.writeFileSync(path.join(OUT, "skill", "README.md"), `# 在蓝区离线判这一包

蓝区没有 dbdog、连不上 server，判题模型**不能回头追问**——材料就这一包，缺什么如实写进 \`summary.md\`。

## 三步

1. 读 \`../manifest.json\`：有几例、label schema 是哪一版（\`id\` 一栏回写时要用，别改）。
2. 把 \`SKILL.md\`（本目录）当 rubric，逐例读 \`../cases/<event_id>/\` 下的四件套：
   \`forward.md\`（agent 实际走的路）、\`reverse.md\`（本该走的路 + 真取到的证据）、
   \`ground-truth.md\`（答案纸；不存在 = 无参照题，\`verdict\` 不许判 \`correct\`）、
   \`probe.json\`（探针两条腿；不存在 = 没跑，\`trustworthy\` 只能按「没抓到撒谎」判 true）。
   \`trace.json\` 是 server 导出的原样 span，需要抠细节时看它。
3. 产两个文件写到**包根**（不是本目录）：
   - \`annotations.jsonl\`：每例一行 \`{"trace_id":"…","labels":{…}}\`，形状见 SKILL.md；
   - \`summary.md\`：本轮总账（判了几例、四项分布、\`needs_fix\` 按 \`fix_where\` 聚合的清单、最该先修的三条、判不动的地方）。
   改了反向链就把修订写到 \`reverse-chain-revisions/<record_id>.md\`（和 \`.json\`）。

## 回黄区之后

把整包搬回黄区，跑：

\`\`\`sh
node scripts/llmobs/judge-package-import.mjs --package <包目录> [--annotator <判题模型名>]
\`\`\`

它按 manifest 里的 label id 回写批注、把总账挂到 run metadata、把反向链修订挂回用例。
**幂等**：重跑就是覆盖，改判不用先删。
`);

const noTrace = cases.filter((c) => !c.trace_id).length;
console.error("");
console.error(`✓ 判题包：${path.resolve(OUT)}（${cases.length} 例，队列 ${QUEUE_NAME}/${queueID}）`);
console.error(`  label：${manifest.label_schema.length} 条${manifest.label_schema.length < LABEL_SCHEMA.length ? "（不全，见上面的警告）" : ""}`);
if (noTrace) console.error(`  ⚠ ${noTrace} 例没有 trace——这几例只有答案纸，判不了行为`);
const noProbe = cases.filter((c) => c.missing.some((m) => m.startsWith("probe"))).length;
if (noProbe) console.error(`  ⚠ ${noProbe} 例没有探针结果，「可信」只能按「没抓到撒谎」判（D2：探针是判可信的唯一硬证据）`);
