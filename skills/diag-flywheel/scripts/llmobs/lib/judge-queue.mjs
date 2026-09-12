// judge-queue.mjs —— 把诊断表里抢到的「判题中」行，配成判题包导得出来的目标。
//
// 判题的判据是**诊断表**（owner 2026-09-11 定：「judge 只看状态是待判题的，先改状态为判题中，
// 再判题，判完之后先上报，再改为判完」）。表给的是一行复现——行上只有 `trace_id`，
// 而导包要的是 `experiment` + `event id`（judge-package-export 按 event id 挑子集）。
// 这一步就是那座桥：拿本用例集解析出来的历次 run（lib/dataset-traces.mjs 的 runsByRecord）
// 按 trace 反查。
//
// 抽成纯函数是因为 loop-judge.mjs 是个一 import 就开跑的入口脚本，配对这段逻辑
// 在里面测不了；而它恰恰是最容易出错的一段——配错了就是判错卷子。
//
// 配不上的**不静默扔掉**，一律带理由分流出去，由调用方放回「待判题」并报数：
// 静默吞掉的行会永远停在判题中，页面上看是「正在判」，其实没有任何人在判它。

/**
 * @param {{id:string,record_id:string,case_source?:string,trace_id?:string}[]} rows 抢到手的诊断行
 * @param {Map<string, {traceId:string,experimentName:string,eventId:string}[]>} runsByRecord 本用例集的历次 run
 * @returns {{targets: {row:object,recordId:string,traceId:string,experiment:string,eventId:string}[],
 *            unresolved: {row:object,reason:"no_trace"|"foreign"|"no_event"|"duplicate_trace"}[]}}
 */
export function matchJudgeTargets(rows, runsByRecord) {
  // trace → run 的索引整张表建一次。按 record 去找也行，但那样就默认了
  // 「行上的 record_id 与 run 挂的 record 一致」——真不一致时会静默配错人，
  // 而 trace 是两边唯一都认的那个键。
  const runByTrace = new Map();
  for (const list of runsByRecord.values()) {
    for (const run of list) {
      if (run.traceId && !runByTrace.has(run.traceId)) runByTrace.set(run.traceId, run);
    }
  }

  const targets = [];
  const unresolved = [];
  const taken = new Set();
  for (const row of rows) {
    const traceId = String(row.trace_id ?? "");
    if (!traceId) { unresolved.push({ row, reason: "no_trace" }); continue; }
    // 抢占是全局的（诊断表上没有用例集这一维，与 loop-diagnose 同一个坑），
    // 所以会抢到别的集合的行。本集合查无此 trace = 不是我的活，放回去。
    const run = runByTrace.get(traceId);
    if (!run) { unresolved.push({ row, reason: "foreign" }); continue; }
    if (!run.eventId) { unresolved.push({ row, reason: "no_event" }); continue; }
    if (taken.has(traceId)) { unresolved.push({ row, reason: "duplicate_trace" }); continue; }
    taken.add(traceId);
    targets.push({
      row,
      recordId: String(row.record_id ?? ""),
      traceId,
      experiment: run.experimentName,
      eventId: run.eventId,
    });
  }
  return { targets, unresolved };
}
