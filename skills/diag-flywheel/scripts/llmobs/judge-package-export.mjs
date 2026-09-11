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
//                        /chain.json + chain.md  重建链：评测方用诊断同款模型把 forward.md 那棵平铺账本读成语义因果链
//                                       （由 chain-rebuild.mjs 在导包后另写；本脚本零模型，不产它；可缺）
//                        /prior-judgments.json  这道题**之前几轮**的判题（改进点 items、复验 checks、修复标记，旧的在前）；
//                                       判这一轮时逐条复验还没关的（飞轮设计 §13.3）。空数组 = 之前没判过
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  baseUrl, findProject, loadDataset,
  listAnnotationQueues, upsertAnnotationQueue, listAnnotationLabels, replaceAnnotationLabels,
  addAnnotationInteractions, listAllExperimentEvents, getExperimentEvent, getTrace,
  resolveExperimentRef, findAllAnnotationsByContent,
  requireCredential,
} from "./lib/exp-client.mjs";
import {
  LABEL_SCHEMA, QUEUE_NAME, renderForward, renderReverse, renderGroundTruth,
  hasGroundTruth, rootSpanOf, stampOf, priorJudgments,
} from "./lib/judge-package.mjs";
import { runsOfRecords } from "./lib/dataset-traces.mjs";

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

// 之前几轮：这一包里每道题在**本轮之前**跑过的运行，连同它们的批注一次取齐。
// 修没修好由后续轮次复验说了算（飞轮设计 §13.3），判题方得先看到之前提过哪些条目。
const packRecordIDs = [...new Set(events.map((e) => e.dataset_record_id).filter(Boolean))];
const priorRunsByRecord = new Map();
for (const [rid, list] of await runsOfRecords({ projectID: project.id, recordIDs: packRecordIDs })) {
  priorRunsByRecord.set(rid, list.filter((r) => r.traceId && r.experimentId !== run.id && r.experimentCreatedAt < (run.created_at ?? "")));
}
const priorInteractions = await findAllAnnotationsByContent([...priorRunsByRecord.values()].flat().map((r) => r.traceId));

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
    // 没有答案纸 = **题坏了**，不是「另一种可判的题」。每道用例都必须有根因，
    // 取自 issue 正文或它对应的已合入的 PR；两处都取不到的题不该进用例集。
    // 这里必须响——被当成「无参照题」按一套自洽性口径悄悄判掉的话，它会在页面上
    // 混成正常分数，再也没人回去补根因。
    missing.push("ground-truth（**题坏了**：expected_output 里没有根因，本例 verdict 只能填 unknown）");
  }

  const prior = priorJudgments(
    (priorRunsByRecord.get(recordID) ?? []).map((r) => ({
      experiment: { id: r.experimentId, name: r.experimentName, created_at: r.experimentCreatedAt },
      traceId: r.traceId,
    })),
    priorInteractions,
  );
  fs.writeFileSync(path.join(caseDir, "prior-judgments.json"), JSON.stringify(prior, null, 1));

  // 探针结果由 probe.mjs 写进本目录；重跑 export 不覆盖已有的那份。
  const probePath = path.join(caseDir, "probe.json");
  if (!fs.existsSync(probePath)) missing.push("probe（探针还没跑：node scripts/llmobs/probe.mjs --case <本目录>）");

  cases.push({
    event_id: eventID,
    trace_id: traceID,
    record_id: recordID,
    status: event?.status ?? summary.status ?? "",
    prior_rounds: prior.length,
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
// 判卷口径只住在插件 dbdog-agent-obs 的 diag-judge skill（2026-09-11 起，mcp 不再下发）。
// 本脚本有两种落点：插件里（`<plugin>/skills/diag-flywheel/scripts/llmobs/` → rubric 在 `../../../diag-judge/SKILL.md`）
// 和 mcp 源码检出（母版 → 兄弟检出 `../dbdog-labs/skills/diag-judge/SKILL.md`）。两处都没有就停：没有 rubric 的包是死包。
const HERE = path.dirname(fileURLToPath(import.meta.url));
const RUBRIC_CANDIDATES = [
  path.resolve(HERE, "..", "..", "..", "diag-judge", "SKILL.md"),
  path.resolve(ROOT, "..", "dbdog-labs", "skills", "diag-judge", "SKILL.md"),
];
const rubric = RUBRIC_CANDIDATES.find((p) => fs.existsSync(p));
if (!rubric) fail(`找不到判卷口径 diag-judge/SKILL.md（找过：${RUBRIC_CANDIDATES.join(" / ")}）——它住在插件 dbdog-agent-obs 的 skills/diag-judge/`);
fs.copyFileSync(rubric, path.join(OUT, "skill", "SKILL.md"));
fs.writeFileSync(path.join(OUT, "skill", "README.md"), `# 在蓝区离线判这一包

蓝区没有 dbdog、连不上 server，判题模型**不能回头追问**——材料就这一包，缺什么如实写进 \`summary.md\`。

## 三步

1. 读 \`../manifest.json\`：有几例、label schema 是哪一版（\`id\` 一栏回写时要用，别改）。
2. 把 \`SKILL.md\`（本目录）当 rubric，逐例读 \`../cases/<event_id>/\` 下的四件套：
   \`forward.md\`（agent 实际走的路）、\`reverse.md\`（本该走的路 + 真取到的证据）、
   \`ground-truth.md\`（答案纸；不存在 = 无参照题，\`verdict\` 填 \`unknown\`）、
   \`probe.json\`（探针结果；不存在 = 没跑，「工具错」只能靠 trace 内两两对照抓）、
   \`prior-judgments.json\`（这道题之前几轮提过的改进点、复验与修复标记；还没关的每一条都要在 \`findings.checks\` 里复验）。
   \`trace.json\` 是 server 导出的原样 span，需要抠细节时看它。
3. 产两个文件写到**包根**（不是本目录）：
   - \`annotations.jsonl\`：每例一行 \`{"trace_id":"…","labels":{…}}\`，形状见 SKILL.md；
   - \`summary.md\`：本轮总账（判了几例、结论与证据的分布、改进点按 \`key\` 聚合的清单（带类别）、本轮复验几条修好 / 仍在、最该先修的三条、判不动的地方）。
   改了反向链就把修订写到 \`reverse-chain-revisions/<record_id>.md\`（和 \`.json\`）。

## 回黄区之后

把整包搬回黄区，跑：

\`\`\`sh
node scripts/llmobs/judge-package-import.mjs --package <包目录> --annotator <判题模型名>
\`\`\`

\`--annotator\` 必填（或导出时带 \`--judge-model\`）：两轮结论不一样时，得分得清是 agent 变了还是判题换了。

它按 manifest 里的 label id 回写批注、把总账挂到 run metadata、把反向链修订挂回用例。
**幂等**：重跑就是覆盖，改判不用先删。
`);

const noTrace = cases.filter((c) => !c.trace_id).length;
console.error("");
console.error(`✓ 判题包：${path.resolve(OUT)}（${cases.length} 例，队列 ${QUEUE_NAME}/${queueID}）`);
console.error(`  label：${manifest.label_schema.length} 条${manifest.label_schema.length < LABEL_SCHEMA.length ? "（不全，见上面的警告）" : ""}`);
if (noTrace) console.error(`  ⚠ ${noTrace} 例没有 trace——这几例只有答案纸，判不了行为`);
const noProbe = cases.filter((c) => c.missing.some((m) => m.startsWith("probe"))).length;
if (noProbe) console.error(`  ⚠ ${noProbe} 例没有探针结果，「工具错」只能靠 trace 内两两对照抓（D2：探针是抓工具错最硬的证据）`);
// 没有答案纸的要单独、响亮地报：这不是材料少一件，是这道题本身该回炉。
const noGT = cases.filter((c) => c.missing.some((m) => m.startsWith("ground-truth")));
if (noGT.length) {
  console.error("");
  console.error(`  ⚠⚠ ${noGT.length} 例没有答案纸——这几道题坏了，不是「无参照题」：`);
  for (const c of noGT) console.error(`       ${c.event_id}（record ${c.record_id || "?"}）`);
  console.error("       判题时只能判工具对错：verdict 填 unknown，改进点必记一条 case 类「这道题没有答案纸」。");
  console.error("       修法：回建用例那一步，从 issue 正文或它对应的已合入的 PR 取根因；两处都没有就删题。");
}
