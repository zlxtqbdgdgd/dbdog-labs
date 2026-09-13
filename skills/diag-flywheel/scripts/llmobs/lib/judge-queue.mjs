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
 * ## 为什么本轮碰过、又没判成的行要攥住，不当场放回
 *
 * server 的抢占是 `... WHERE status = $1 ORDER BY created_at, id LIMIT 1 FOR UPDATE SKIP LOCKED`：
 * **放回去的行 created_at 没变，下一次 claim 会立刻又领到它**。当场放回有两个后果，都很重：
 *   · 配不上本用例集的行（抢占是全局的，诊断表上没有用例集这一维）会一直站在队头，
 *     本轮再也走不到自己那几条；
 *   · **判失败的行更糟**——领到的是同一条，于是撞上「同一行领两次」的兜底而提前收摊。
 *     队头只要有一条稳定失败的行（比如那道题导包恒失败），它后面的所有行就永远判不到。
 * 所以凡是本轮碰过、又没判成的，一律攥着（停在 `judging`），等本轮结束一起放回。
 * 代价：这些行在本轮期间显示「判题中」。进程被 kill 也有租约兜底。
 *
 * @param {{
 *   claim: () => Promise<object|null>,
 *   resolve: (row: object) => { target?: object, reason?: string },
 *   judge: (target: object) => Promise<"ok"|"failed"|"skipped"|"blocked">,
 *   release: (row: object) => Promise<void>,
 *   limit?: number,
 *   onSkip?: (row: object, reason: string) => void,
 * }} io
 *   `judge` 回四种结果：`ok` 判完并已推进状态（行不用放回）；`failed` 判砸了；
 *   `skipped` 没判也不算砸（`--dry-run` 就是这种，否则空跑会让退出码骗调度）；
 *   `blocked` 开跑前守门没过、**行已经被改成 blocked 了**（蓝图 0028）。抛异常按 `failed` 算。
 *
 *   `blocked` 与 `failed` 分开是必须的，不是记账好看：failed 的行会被攥到本轮末尾放回
 *   「待判题」，而 blocked 的行已经不在 judging 了——再放一次只会吃 409，更要紧的是
 *   放回去下一轮立刻又领到、又挡一次，队头一条就能把后面全挡住（那正是「攥住」这套
 *   机制当初要治的病）。挡住的行靠下一轮开头的探活统一解除。
 * @returns {Promise<{ok:number, failed:number, skipped:number, blocked:number}>}
 *   `limit` 数的是**判了几条**（ok+failed），配不上的与被挡住的都不占配额——
 *   否则用户说「判 3 条」，可能被别的用例集的三条行、或三条环境不通的行吃光。
 */
export async function walkJudgeQueue({ claim, resolve, judge, release, limit = 0, onSkip, shouldStop }) {
  const held = [];            // 本轮碰过、没判成的：攥到本轮结束再放（理由见上）
  const seenTraces = new Set();
  const seenRows = new Set(); // 兜底：真出现同一行被领两次（攥住之后不该发生），停下来而不是转圈
  let ok = 0, failed = 0, skipped = 0, blocked = 0;

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

      let outcome = "failed";
      try {
        outcome = await judge(target);
      } catch (e) {
        // 判一条炸了不该把整轮带走，更不该让这条行留在 judging 等一个钟头的租约
        console.error(`✗ 判 ${target.eventId ?? row.id} 抛错：${e?.message ?? e}`);
        outcome = "failed";
      }
      if (outcome === "ok") ok += 1;
      // blocked 的行**不攥**：它已经被改成 blocked，不在 judging 了。
      else if (outcome === "blocked") blocked += 1;
      else {
        held.push(row);
        if (outcome === "skipped") skipped += 1;
        else failed += 1;
      }
      // **收手信号**（2026-09-12）：插件在本轮中途被同步到了新版本，判完手上这条就停。
      // 热更新做不到——loop 进程已经把脚本加载进内存，包里那份 rubric 也是从正在跑的
      // 那份脚本自己的目录拷的。所以「变了就停下，重启即新的」，别用旧代码把剩下几十例跑完，
      // 跑出来那批和新口径不可比、外面却看不出差别。
      // **收尾不是硬退**：手上这条已经判完、状态推干净了，攥着的行照常在 finally 里放回。
      if (shouldStop?.()) break;
    }
  } finally {
    // 攥着的一律放回，哪怕本轮中途出错——留在 judging 的行页面上显示「正在判」，是在骗人
    for (const row of held) {
      try { await release(row); } catch { /* 等租约回收 */ }
    }
  }
  return { ok, failed, skipped, blocked };
}
