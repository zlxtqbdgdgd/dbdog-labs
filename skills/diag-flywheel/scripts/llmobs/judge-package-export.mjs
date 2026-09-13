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
//                        /prior-judgments.json  这道题**之前几轮**的判题（改进点 items、复验 checks、修复标记，旧的在前）；
//                                       判这一轮时逐条复验还没关的（飞轮设计 §13.3）。空数组 = 之前没判过
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { openFindings } from "./lib/judge-quality.mjs";
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
// 保留兼容老命令行；upsert 之后它与默认行为等价（见 ensureQueue 注释）。
const FORCE_RELABEL = has("--force-relabel");
void FORCE_RELABEL;

if (!EXPERIMENT) fail("--experiment 必填");
if (!OUT) fail("--out 必填");
requireCredential();

/**
 * 队列与 label schema：**每次都对齐一次词表**（PUT 是幂等的）。
 *
 * 2026-09-12 之前不是这样：server 的 ReplaceAnnotationLabelSchemas 实现为「DELETE 全部 label
 * + 用新 id 重插」，而 `llmobs_annotations.label_id` 是 ON DELETE CASCADE，一发 PUT 就把该队列
 * 全部批注级联删光。那时这里只好分三档（全新才写 / --force-relabel / 只告警），结果是**词表
 * 改不动**——要给 verdict 加一个取值，代价是丢掉全部判题历史。
 *
 * 那是 server 的 bug，已按 `(queue_id, label)` upsert 修掉：命中已有行时 id 不变，批注挂得住。
 * 于是这里回到它本该有的样子。`--force-relabel` 保留但已无特殊含义（现在两条路一样安全）。
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
  // **每次都对齐一次词表**（2026-09-12 起）。
  //
  // 原先这里分三档：队列全新才写、`--force-relabel` 才整份替换、否则只告警不动——理由是
  // server 的「整份替换」实现为「删光重建 + 换新 id」，而批注的 `label_id` 是 ON DELETE CASCADE，
  // 一发 PUT 就把这个队列里所有历史批注级联删光。于是「给 verdict 加一个取值」实际代价是
  // 「丢掉全部判题历史」，词表改不动，调用方只能绕道在别处另记一份。
  //
  // server 已按 `(queue_id, label)` upsert 修掉（命中已有行时 id 不变，批注挂得住），
  // 所以这条 PUT 现在是安全且幂等的：新增取值、改 display、补一条 label 都能直接生效。
  // 只有**从词表里去掉**一个 label 才会连带删它名下的值——那是对的，那些值已经没有定义可依。
  const before = new Set(labels.map((l) => l.label));
  labels = await replaceAnnotationLabels(queueID, wanted);
  const added = LABEL_SCHEMA.map((l) => l.label).filter((l) => !before.has(l));
  if (before.size === 0) console.error(`label schema 首次写入：${labels.length} 条`);
  else if (added.length) console.error(`label schema 已对齐：补上 ${added.join(", ")}（已有批注不受影响）`);
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

  // 答案纸取**用例当前的**那份，不是实验事件里的快照。
  // 两者是不同的东西：题面（`input.prompt`）必须用当时的快照——那才是 agent 看到的；
  // 而答案纸是**我们对这个 bug 的判断**，它被更正之后旧轨迹也该按更正后的判。
  // 2026-09-11 的「根因 / 修复分离」清洗就是这么一件事：只认快照的话，那次清洗对历史一轮都不生效，
  // 重判旧 trace 仍按坏答案纸打分，清洗白做。
  const expected = record?.expected_output ?? event?.expected_output;
  const corrected = Boolean(record?.expected_output && event?.expected_output
    && JSON.stringify(record.expected_output) !== JSON.stringify(event.expected_output));
  if (corrected) console.error(`  · 答案纸在这一轮跑完之后被更正过，按当前那份判`);
  if (hasGroundTruth(expected)) {
    fs.writeFileSync(path.join(caseDir, "ground-truth.md"), renderGroundTruth(expected, { eventId: eventID, corrected }));
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

  // **待复验清单随包走**：rubric 要判题方「开判第一件事就是拿这份清单」，但判题会话的
  // 工作目录是这个临时包，里面既没有 `case-history.mjs` 也没有凭证——照 rubric 做不到，
  // 只能退回「自己在几十条历史里推」，正是那条规则要取代的做法。这里把脚本算好的结果放进包。
  const open = openFindings(prior);
  fs.writeFileSync(path.join(caseDir, "open-findings.json"), JSON.stringify(open, null, 1));
  if (open.length) console.error(`  · 待复验 ${open.length} 条：${open.map((o) => o.key).join("、")}`);

  // 探针结果由 probe.mjs 写进本目录；重跑 export 不覆盖已有的那份。
  const probePath = path.join(caseDir, "probe.json");
  if (!fs.existsSync(probePath)) missing.push("probe（探针还没跑：node scripts/llmobs/probe.mjs --case <本目录>）");

  // 答案纸里的根因**按顺序带进 manifest**：判题方按这个顺序编号划分命中 / 没命中，
  // import 据此核 `findings.roots`，并推导 verdict（`deriveVerdictFromRoots`）。
  // 带原文而不是只带条数，是为了让人看回流报错时知道第 2 条指的是哪一条。
  //
  // **三态，不是两态**（2026-09-11 晚修）：
  //   · 数组 → 核集合；
  //   · `null` = 有答案纸、但根因不在 `expected_roots` 这个数组里（答案纸是整段文字、
  //     或只有 expected_phenomena）。这种**不核集合**，判题方照答案纸的文字判 verdict。
  //     早前把它和「没有答案纸」一起压成 `[]`，于是包里明明躺着 ground-truth.md，
  //     回流却报「这道题没有答案纸，verdict 只能是 unknown」——报错与材料自相矛盾，整包白判。
  //   · `[]` = 真没有答案纸（题坏了）。
  const expectedRoots = hasGroundTruth(expected)
    ? (Array.isArray(expected?.expected_roots) && expected.expected_roots.length
      ? expected.expected_roots.map((r) => String(r))
      : null)
    : [];
  // 还没做「根因 / 修复分离」的题：根因数组里混着 `【根因】`『【修复】』这类小标题、PR 链接、
  // 整段 diff（2026-09-11 扫全集：141 条里 80 条不是根因）。混装时按集合算命中没有意义——
  // 判官只能把小标题也标成命中。报出来，别让判题方以为这就是一份干净的答案纸。
  const mixed = (expectedRoots ?? []).filter((r) => /^【[^】]{1,8}】|^(PR|pr|issue|Issue)\s*#?\s*\d|^(---|\+\+\+|@@|diff --git)|^[+-]\s/.test(String(r).trim()));
  if (mixed.length) {
    missing.push(`答案纸还没做「根因 / 修复分离」：${expectedRoots.length} 条里 ${mixed.length} 条是小标题 / PR 链接 / diff 行，按集合算命中会虚高（控制台用例页编辑一次即分开）`);
  }
  if (expectedRoots === null) {
    missing.push("expected_roots（答案纸有正文但没有结构化根因：本例不核根因集合，judge 照文字判，并提一条 case 让建用例那步补上）");
  }

  cases.push({
    event_id: eventID,
    trace_id: traceID,
    record_id: recordID,
    expected_roots: expectedRoots,
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

/**
 * 这一版判卷口径的身份：`<插件版本>+<正文前 12 位 sha256>`。
 *
 * **两样都要**：插件版本是人看得懂的那个数，但开发期改了正文不升版本是常事；正文哈希不会骗人，
 * 却没人记得住。拼在一起，跨轮聚合按它分组时既读得懂又分得开。
 * 找不到 plugin.json（母版检出直接跑）时版本位写 `unknown`——**不编一个**。
 */
function rubricIdentity(rubricPath) {
  const body = fs.readFileSync(rubricPath);
  const sha = createHash("sha256").update(body).digest("hex").slice(0, 12);
  let version = "unknown";
  let dir = path.dirname(rubricPath);
  for (let i = 0; i < 4; i++) {
    const manifestPath = path.join(dir, ".claude-plugin", "plugin.json");
    if (fs.existsSync(manifestPath)) {
      try {
        version = String(JSON.parse(fs.readFileSync(manifestPath, "utf8")).version ?? "unknown");
      } catch { /* 版本读不出来就留 unknown：哈希那一半照样认得出是哪一版 */ }
      break;
    }
    dir = path.dirname(dir);
  }
  return { version, sha256: sha, id: `${version}+${sha}` };
}

const manifest = {
  generated_at: new Date().toISOString(),
  server: baseUrl(),
  project: { id: project.id, name: PROJECT },
  dataset: datasetName || null,
  experiment: { id: run.id, name: run.name ?? EXPERIMENT },
  queue: { id: queueID, name: QUEUE_NAME },
  // label id 是这个包的一等资产：回写时按它认 label。（2026-09-12 之前这里写的是「永不重发
  // PUT labels（重发 = 删光批注）」——那是 server 把整份替换实现成「删光重建 + 换新 id」造成的，
  // 已按 (queue_id,label) upsert 修掉；现在每次导出都会对齐一次词表。）
  label_schema: labels.map((l) => ({
    id: l.id, label: l.label, value_type: l.value_type,
    ...(l.options ? { options: l.options } : {}), position: l.position,
    display: LABEL_SCHEMA.find((s) => s.label === l.label)?.display ?? "",
  })),
  judge_model: JUDGE_MODEL || null,
  // 判的是**哪一版口径**（2026-09-12）。开跑前守门逐例同步 plugin，所以一轮里前后几例用的
  // 可能不是同一版 rubric；不记就分不清跨轮差异来自「判官变了」还是「口径变了」，
  // 而 `annotator` 当初存在的理由正是要把这两件事分开。import 照它写进 `rubric_version`。
  rubric: rubricIdentity(rubric),
  cases,
};
fs.writeFileSync(path.join(OUT, "manifest.json"), JSON.stringify(manifest, null, 1));

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
