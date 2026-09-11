// 用例集 → 题 → 历次诊断（trace）。这条解析线只写一次：loop-pending（检测新增）与
// training-corpus-export（按用例集导语料）都从这里拿，别各自再翻一遍 experiments。
//
// trace 与题之间的线有两种，两种都算：
//   ① 跑批跑这道题跑出来的：experiment event 的 dataset_record_id → trace_id
//   ② 题是从那次诊断沉淀的：record.metadata.source_trace
// 只算 ①，人手沉淀的题会被当成「没跑过」；只算 ②，跑批跑出来的都不属于这个集合。

import { findProject, findDataset, listRecords, listCPExperiments, listAllExperimentEvents } from "./exp-client.mjs";

/**
 * @param {{ project: string, dataset: string }} names 按名字找（命令行按名字指集合，id 只有页面知道）
 * @returns {Promise<{ project: {id:string,name:string}, dataset: {id:string,name:string},
 *   records: any[], runsByRecord: Map<string, {experimentId:string,experimentName:string,traceId:string,eventId:string}[]>,
 *   traceIds: Set<string> }>}
 * @throws 集合或项目不存在——调用方决定怎么报
 */
export async function resolveDatasetTraces({ project: projectName, dataset: datasetName }) {
  const project = await findProject(projectName);
  if (!project?.id) throw new Error(`project 不存在：${projectName}`);
  const dataset = await findDataset(project.id, datasetName);
  if (!dataset?.id) throw new Error(`dataset 不存在：${datasetName}（project ${projectName}）`);
  const records = await listRecords(project.id, dataset.id);
  const runsByRecord = await runsOfRecords({ projectID: project.id, recordIDs: records.map((r) => r.id) });
  const traceIds = new Set();
  for (const list of runsByRecord.values()) for (const run of list) if (run.traceId) traceIds.add(run.traceId);
  for (const r of records) {
    const st = r.attributes?.metadata?.source_trace ?? r.metadata?.source_trace;
    if (typeof st === "string" && st) traceIds.add(st);
  }
  return { project, dataset, records, runsByRecord, traceIds };
}

/**
 * 一批题在各轮的运行：翻 project 下全部轮次的 events，按 dataset_record_id 归到题上。
 * 带上轮次的建行时刻——**判题跟着轮次走**（飞轮设计 §13），「之前几轮」得按它排。
 *
 * @param {{ projectID: string, recordIDs: Iterable<string> }} q
 * @returns {Promise<Map<string, {experimentId:string,experimentName:string,experimentCreatedAt:string,traceId:string,eventId:string}[]>>}
 */
export async function runsOfRecords({ projectID, recordIDs }) {
  const wanted = new Set(recordIDs);
  const runsByRecord = new Map();
  for (const exp of await listCPExperiments({ projectID })) {
    let events = [];
    try {
      events = await listAllExperimentEvents(exp.id);
    } catch {
      continue; // 单个 run 取不到 events 不该让整轮失败
    }
    for (const ev of events) {
      const rid = ev.dataset_record_id;
      if (!rid || !wanted.has(rid)) continue; // 别的集合的题、或已删的题
      const list = runsByRecord.get(rid) ?? [];
      list.push({ experimentId: exp.id, experimentName: exp.name, experimentCreatedAt: exp.created_at ?? "", traceId: ev.trace_id ?? "", eventId: ev.id });
      runsByRecord.set(rid, list);
    }
  }
  return runsByRecord;
}
