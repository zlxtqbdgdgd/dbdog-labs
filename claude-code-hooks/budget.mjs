// budget.mjs — 有预算的并发 map：**出图不许被模型拖住**（2026-09-12）。
//
// 背景：graph-worker 的代码证据那一步要给每条子代理回参各发一次模型调用，原来是串行
// `await`，而且整张图要等这一步全跑完才写盘、才推 server。于是模型一慢，连**不需要模型的
// 工具边**都一起看不见——本轮 trace 11d77280 就是这个症状。单条调用本身有 30s 超时
// （summary.mjs 的 AbortSignal.timeout），但 N 条串起来没有任何上限。
//
// 这里只解决调度：并发上限压墙钟，整体截止时间兜底。到点之后**没开工的不再开工**，
// 已经拿到的照样进图——少几条代码证据边，比整张图出不来强。
// 在途的那几条不去打断（fetch 自己会超时），结果丢弃即可，进程等它们自然退出。

const DEFAULT_CONCURRENCY = 3;
const DEFAULT_BUDGET_MS = 90_000;

/**
 * @param {Array<T>} items
 * @param {(item: T, ctx: { remainingMs: number, index: number }) => Promise<R>} worker
 *   `remainingMs` 是**当下**的剩余预算，调用方应把它压进单次请求的超时，
 *   否则一条慢调用就能吃光整份预算。
 * @param {{ concurrency?: number, budgetMs?: number, now?: () => number }} opts
 * @returns {{ results: Array<R|null>, done: number, failed: number, skipped: number, timedOut: boolean }}
 *   `results` 与 `items` 同序等长：没跑成的（失败或没轮上）是 null。
 */
export async function mapWithBudget(items, worker, opts = {}) {
  const list = items ?? [];
  const concurrency = Math.max(1, opts.concurrency ?? DEFAULT_CONCURRENCY);
  const budgetMs = opts.budgetMs ?? DEFAULT_BUDGET_MS;
  const now = opts.now ?? Date.now;
  const deadline = now() + budgetMs;

  const results = new Array(list.length).fill(null);
  let next = 0;
  let done = 0;
  let failed = 0;
  let skipped = 0;

  async function lane() {
    for (;;) {
      const index = next++;
      if (index >= list.length) return;
      const remainingMs = deadline - now();
      if (remainingMs <= 0) {
        // 预算已尽：这条以及后面的全部记为「没轮上」，不发请求。
        skipped += list.length - index;
        next = list.length;
        return;
      }
      try {
        results[index] = await worker(list[index], { remainingMs, index });
        done += 1;
      } catch {
        // 单条失败不连坐——调用方自己在 worker 里留痕，这里只保证其余继续。
        failed += 1;
      }
    }
  }

  await Promise.all(Array.from({ length: Math.min(concurrency, list.length) }, lane));
  return { results, done, failed, skipped, timedOut: skipped > 0 };
}
