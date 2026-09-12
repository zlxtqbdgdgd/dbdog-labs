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

/**
 * 走一轮判题队列：**领一条 → 判一条 → 再领下一条**。
 *
 * ## 为什么不是「先领一批再串行判」
 *
 * 租约 = 判题超时 × 2（默认 1 小时），而判一例要几十分钟。一次领 3 条，排在后面那条还没轮到
 * 租约就过期了——下一轮（loop 默认 30 分钟一次）会把它当成「卡死的行」抢走**并真的开判**：
 * 两个会话判同一条 trace，批注互相覆盖，先判完那个推「已判」还会吃 409。
 * 流式领之后，租约永远只覆盖**正在判的那一条**。
 *
 * ## 为什么配不上的行要攥住、不当场放回
 *
 * server 的抢占是 `... WHERE status = $1 ORDER BY created_at, id LIMIT 1 FOR UPDATE SKIP LOCKED`：
 * **放回去的行 created_at 没变，下一次 claim 会立刻又领到它**。当场放回 = 队头站着一条别的
 * 用例集的行，本轮再也走不到自己那几条（诊断表上没有用例集这一维，抢占是全局的）。
 * 所以这里攥着它们——它们停在 `judging`，等本轮结束一起放回。
 * 代价：别的用例集的那几条在本轮期间显示「判题中」。真被 kill 了也有租约兜底。
 *
 * @param {{
 *   claim: () => Promise<object|null>,
 *   resolve: (row: object) => { target?: object, reason?: string },
 *   judge: (target: object) => Promise<boolean>,
 *   release: (row: object) => Promise<void>,
 *   limit?: number,
 *   onSkip?: (row: object, reason: string) => void,
 * }} io
 * @returns {Promise<{ok:number, failed:number, skipped:number}>} `limit` 数的是**判了几条**（ok+failed），
 *   配不上的不占配额——否则用户说「判 3 条」，可能被别的用例集的三条行吃光。
 */
export async function walkJudgeQueue({ claim, resolve, judge, release, limit = 0, onSkip }) {
  const held = [];            // 配不上的：攥到本轮结束再放
  const seenTraces = new Set();
  const seenRows = new Set(); // 兜底：真出现同一行被领两次（不该发生），停下来而不是转圈
  let ok = 0, failed = 0, skipped = 0;

  try {
    while (limit === 0 || ok + failed < limit) {
      const row = await claim();
      if (!row) break;
      if (seenRows.has(row.id)) { held.push(row); break; }
      seenRows.add(row.id);

      const { target, reason } = resolve(row) ?? {};
      if (!target) {
        onSkip?.(row, reason ?? "unresolved");
        held.push(row);
        skipped += 1;
        continue;
      }
      if (seenTraces.has(target.traceId)) {
        onSkip?.(row, "duplicate_trace");
        held.push(row);
        skipped += 1;
        continue;
      }
      seenTraces.add(target.traceId);

      if (await judge(target)) ok += 1;
      else failed += 1;
    }
  } finally {
    // 攥着的一律放回，哪怕本轮中途出错——留在 judging 的行页面上显示「正在判」，是在骗人
    for (const row of held) {
      try { await release(row); } catch { /* 等租约回收 */ }
    }
  }
  return { ok, failed, skipped };
}
