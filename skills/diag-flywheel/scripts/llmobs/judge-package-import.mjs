#!/usr/bin/env node
// judge-package-import.mjs — 判题包的回传件打回三个落点（飞轮 P2，设计 §7.3 / D5）。
//
//   annotations.jsonl            → annotation 写口（批注是**原件**；分数由 server 从批注投影，判题方只交一次）
//   summary.md                   → run metadata `judge_summaries[<event_id>]`（例级总评；一例一会话，互不覆盖）
//   reverse-chain-revisions/*    → dataset record 的 `metadata.reverse_chain`（反向链也在飞轮里进化，D3）
//
// 用法：
//   node scripts/llmobs/judge-package-import.mjs --package <dir> --annotator <判题模型名> [--dry-run]
//   （--annotator 必填，除非导出时带了 --judge-model、manifest 里已记）
//
// 幂等：重跑就是覆盖。annotation 的 `(interaction_id,label_id)` 唯一，改判不留历史（D5）——
// 所以「重判」= 改 annotations.jsonl 再跑一次，不要追加第二行同 trace_id 的记录。
//
// env 同 run-experiment（DBDOG_BASE_URL / DBDOG_API_KEY 或 DBDOG_INTERNAL_TOKEN / DBDOG_ORG）。
import fs from "node:fs";
import path from "node:path";
import {
  CP, baseUrl, callStatus, addAnnotationInteractions, upsertAnnotations,
  resolveExperimentRef, patchCPExperiment, findProject, findDataset, listRecords,
  requireCredential,
} from "./lib/exp-client.mjs";
import { parseAnnotationsJsonl, annotationPayload } from "./lib/judge-package.mjs";

const argOf = (name, dflt) => {
  const i = process.argv.indexOf(name);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : dflt;
};
const has = (name) => process.argv.includes(name);
const fail = (m) => { console.error(`✗ ${m}`); process.exit(1); };

const PKG = argOf("--package", "");
const ANNOTATOR_ARG = argOf("--annotator", "");
const DRY = has("--dry-run");

if (!PKG) fail("--package 必填");
requireCredential();

const read = (rel) => {
  const p = path.join(PKG, rel);
  return fs.existsSync(p) ? fs.readFileSync(p, "utf8") : null;
};

const manifestRaw = read("manifest.json");
if (!manifestRaw) fail(`${path.join(PKG, "manifest.json")} 不存在——这不是一个判题包`);
const manifest = JSON.parse(manifestRaw);
const labelIds = Object.fromEntries((manifest.label_schema ?? []).map((l) => [l.label, l.id]));
// manifest.experiment：P3 起是 `{id,name}`（id = 控制面 uuid，总账直接 PATCH 它）；
// 更早导出的包里是一个自由串，按名解析一次（同 --parent 的规则）。
const expRef = manifest.experiment;
const expIsObj = expRef !== null && typeof expRef === "object";
const EXPERIMENT_ID = expIsObj ? String(expRef.id ?? "") : "";
const EXPERIMENT_NAME = expIsObj ? String(expRef.name ?? "") : String(expRef ?? "");
const annotator = ANNOTATOR_ARG || manifest.judge_model || "";
// 判题模型必须记下来（飞轮设计 §13.2 #6）：此前只警告照写，线上 5 条判过的 trace 里 3 条批注是
// annotator=default——同一道题两轮结论不一样时，分不清是 agent 变了还是判题换了。
if (!annotator) fail("没有 --annotator，manifest 里也没记判题模型——判题模型不记下来，两轮结论不一样时分不清是谁变了");

const gaps = [];   // 与 server 契约不符 / 写口缺失，最后一起报，不静默吞
let wrote = 0;

// ── ① 批注 ────────────────────────────────────────────────────────────────────
const jsonl = read("annotations.jsonl");
if (!jsonl) {
  console.error("⚠ 包里没有 annotations.jsonl——这一轮还没判，跳过批注回写");
} else {
  const { rows, problems } = parseAnnotationsJsonl(jsonl);
  for (const p of problems) console.error(`⚠ ${p}`);
  if (!rows.length) fail("annotations.jsonl 里没有一行可用记录");
  // 形状不合契约就整包不写：写进去的旧形状（一段 fix_where 塞五处改动、或 2026-09-11 之前的词表）数不出哪处修了，
  // 而写了一半的包比一行没写更难收拾（飞轮设计 §13.3）。
  const invalid = rows.filter((r) => r.invalid?.length);
  if (invalid.length) {
    fail(`判题产物有 ${invalid.length} 行不合契约（上面的 ⚠ 逐条列了）——改完重跑 import，这一次一行都没写`);
  }

  const known = new Set((manifest.cases ?? []).map((c) => c.trace_id).filter(Boolean));
  const stray = rows.filter((r) => !known.has(r.trace_id));
  for (const r of stray) console.error(`⚠ 第 ${r.line} 行的 trace_id ${r.trace_id} 不在本包的用例里——照样回写，但核一眼是不是判串了`);

  // 排队拿 interaction id（幂等：同 (queue,content) 覆盖 content_kind）。
  const interactions = DRY ? [] : await addAnnotationInteractions(
    manifest.queue.id,
    rows.map((r) => ({ content_id: r.trace_id, content_kind: "trace" })),
  );
  const idOf = new Map(interactions.map((it) => [it.content_id, it.id]));

  const payload = [];
  for (const row of rows) {
    const interactionId = idOf.get(row.trace_id);
    if (!DRY && !interactionId) {
      console.error(`⚠ ${row.trace_id} 排队后没拿到 interaction id，跳过`);
      continue;
    }
    const skipped = Object.keys(row.labels).filter((l) => !labelIds[l]);
    if (skipped.length) {
      console.error(`⚠ ${row.trace_id}：manifest 里没有 ${skipped.join(", ")} 的 label id，这几项写不进去`);
      gaps.push(`label ${skipped.join(", ")} 在队列里不存在（export 时已警告过；补齐要另起队列名，重发 PUT labels 会删光已有批注）`);
    }
    const usable = Object.fromEntries(Object.entries(row.labels).filter(([l]) => labelIds[l]));
    payload.push(...annotationPayload({ interactionId: interactionId ?? "(dry-run)", labels: usable, labelIds, annotator }));
  }
  if (DRY) {
    console.error(`[dry-run] 会写 ${payload.length} 条 annotation（${rows.length} 例）`);
  } else if (payload.length) {
    const saved = await upsertAnnotations(payload);
    wrote += saved.length;
    console.error(`✓ 批注 ${saved.length} 条（${rows.length} 例，annotator=${annotator || "（空）"}）`);
    console.error("  finding_kinds 已从 findings 算出一起写；分数不用另写：server 收到 annotation 后自动投影成 experiment metric 与 root span 的 evaluation.* tag");
  }
}

// ── ② 本轮总账 → run metadata ────────────────────────────────────────────────
const summary = read("summary.md");
if (!summary) {
  console.error("⚠ 包里没有 summary.md——本轮总账不回写");
} else {
  // 落点就是 manifest 里那条 run 的 uuid（P3 起 runner 先建行后跑批，export 把 id 记进了包）。
  // 这里仍要读回一次：`judge_summary` 是**并进** metadata 的，不能把 run 自己的 notes 盖掉。
  const target = await resolveExperimentRef(EXPERIMENT_ID || EXPERIMENT_NAME, {
    projectID: manifest.project?.id ?? "",
  }).catch((e) => {
    gaps.push(`控制面 experiments 读不到：${e.message || e}`);
    return null;
  });
  if (!target?.id) {
    gaps.push(
      `run metadata 无落点：控制面里找不到 experiment ${EXPERIMENT_ID || EXPERIMENT_NAME || "（manifest 没记）"}。` +
      `judge_summary 只有 PATCH ${CP}/experiments/{uuid} 能写；` +
      "包里没有 uuid 的话（P3 之前导出的）重跑一次 export 就有了——本轮把总账留在包里。",
    );
    console.error(`⚠ 总账没写回：控制面找不到 experiment ${EXPERIMENT_ID || EXPERIMENT_NAME}（见末尾缺口）`);
  } else if (DRY) {
    console.error(`[dry-run] 会把 summary.md（${summary.length} 字符）写进 experiment ${target.id} 的 metadata.judge_summary`);
  } else {
    // **按例累积，不是整体覆盖**。判题是一例一个会话（judge-package-export --cases），
    // 同一个 run 下的每一例都会走到这里；直接写 `judge_summary` 的话，后一例把前一例盖掉，
    // 一轮跑完只剩最后那份（2026-09-10 实测：三例跑完，前两例的总账没了）。
    // 落成以 event id 为键的字典，每例一格；轮级总账由聚合步骤另算，不在这里拼。
    const prev = target.metadata ?? {};
    const bucket = { ...(prev.judge_summaries && typeof prev.judge_summaries === "object" ? prev.judge_summaries : {}) };
    // 键取 manifest 里的 event id——`rows` 是上面那个块的局部变量，这里取不到；
    // manifest.cases 才是本包覆盖面的权威。
    const keys = (manifest.cases ?? []).map((c) => c.event_id || c.trace_id).filter(Boolean);
    for (const k of (keys.length ? keys : [path.basename(PKG)])) bucket[k] = summary;
    const metadata = {
      ...prev,
      judge_summaries: bucket,
      judge_summary_at: new Date().toISOString(),
      ...(annotator ? { judge_model: annotator } : {}),
    };
    await patchCPExperiment(target.id, { metadata });
    console.error(`✓ 本例总账 → experiment ${target.id} 的 metadata.judge_summaries（${Object.keys(bucket).length} 例在册）`);
  }
}

// ── ③ 反向链修订 → dataset record ────────────────────────────────────────────
const revDir = path.join(PKG, "reverse-chain-revisions");
if (fs.existsSync(revDir)) {
  const files = fs.readdirSync(revDir).filter((f) => f.endsWith(".json"));
  const mdOnly = fs.readdirSync(revDir).filter((f) => f.endsWith(".md") && !files.includes(f.replace(/\.md$/, ".json")));
  for (const f of mdOnly) console.error(`⚠ ${f} 只有 markdown 没有 .json——反向链原样进 record 的是 .json，这份挂不回去`);

  let recordsByID = new Map();
  if (files.length && manifest.dataset) {
    const project = await findProject(manifest.project?.name ?? "");
    const dataset = project?.id ? await findDataset(project.id, manifest.dataset) : null;
    if (dataset?.id) {
      const rows = await listRecords(project.id, dataset.id);
      recordsByID = new Map(rows.map((r) => [r.id, r]));
    }
  }

  for (const file of files) {
    const recordID = file.replace(/\.json$/, "");
    const chain = JSON.parse(fs.readFileSync(path.join(revDir, file), "utf8"));
    const record = recordsByID.get(recordID);
    if (!record) {
      gaps.push(`反向链修订 ${recordID}：在 dataset ${manifest.dataset ?? "?"} 里找不到这条 record`);
      continue;
    }
    const metadata = { ...(record.metadata ?? {}), reverse_chain: chain, reverse_chain_revised_at: new Date().toISOString() };
    if (DRY) {
      console.error(`[dry-run] 会更新 record ${recordID} 的 metadata.reverse_chain`);
      continue;
    }
    // DD 形：`PATCH …/{project}/datasets/{dataset}/records`，集合路由一次一批（没有 /records/{id} 这层），
    // body `{data:{type:"datasets",attributes:{records:[{id, metadata}]}}}`；server 6aa2faed 起有，改一次 = dataset 版本 +1。
    // 老 server 回 404 就如实报缺口、修订件留在包里，不假装写成功。
    const res = await callStatus("PATCH",
      `${CP}/${manifest.project.id}/datasets/${record.dataset_id ?? ""}/records`,
      { data: { type: "datasets", attributes: { records: [{ id: recordID, metadata }] } } });
    if (res.ok) {
      wrote += 1;
      console.error(`✓ 反向链修订 → record ${recordID}（dataset 出新版本）`);
    } else {
      gaps.push(
        `反向链修订 ${recordID} 写不进去（HTTP ${res.status}）：server 没有 PATCH ${CP}/{projectID}/datasets/{datasetID}/records` +
        "（server ≥ 6aa2faed 才有）。修订件留在包里。",
      );
    }
  }
}

// ── 收尾 ──────────────────────────────────────────────────────────────────────
console.error("");
console.error(`${gaps.length ? "△" : "✓"} import 完成：写入 ${wrote} 项（server ${baseUrl()}）`);
for (const g of [...new Set(gaps)]) console.error(`  缺口：${g}`);
process.exit(gaps.length ? 2 : 0);
