// budget.mjs 的用例：出图这条路上「模型慢」不许拖垮整张图（2026-09-12）。
// 时钟注入 + 手动 deferred，全程无真实定时器，不靠 sleep 判定。
import { describe, expect, it } from "vitest";
import { mapWithBudget } from "./budget.mjs";

/** 手动控制完成时机的 worker 工厂：返回 [worker, 把第 i 条放行的函数, 调用记录]。 */
function deferredWorker() {
  const calls = [];
  const resolvers = [];
  const worker = (item, ctx) => {
    calls.push({ item, remainingMs: ctx.remainingMs });
    return new Promise((resolve, reject) => resolvers.push({ resolve, reject }));
  };
  return { worker, calls, resolvers };
}

const tick = () => new Promise((r) => setImmediate(r));

describe("mapWithBudget", () => {
  it("并发不超过上限，放行一条才补下一条", async () => {
    const { worker, calls, resolvers } = deferredWorker();
    const p = mapWithBudget([1, 2, 3, 4, 5], worker, { concurrency: 2, budgetMs: 10_000 });
    await tick();
    expect(calls.map((c) => c.item)).toEqual([1, 2]);
    resolvers[0].resolve("a");
    await tick();
    expect(calls.map((c) => c.item)).toEqual([1, 2, 3]);
    resolvers.slice(1).forEach((r, i) => r.resolve(`v${i}`));
    await tick();
    await tick();
    resolvers.slice(3).forEach((r) => r.resolve("z"));
    const out = await p;
    expect(out.results.length).toBe(5);
  });

  it("预算用尽后没开工的不再开工，已拿到的照常返回", async () => {
    const clock = { t: 0 };
    const { worker, calls, resolvers } = deferredWorker();
    const p = mapWithBudget([1, 2, 3, 4], worker, {
      concurrency: 1, budgetMs: 100, now: () => clock.t,
    });
    await tick();
    expect(calls.map((c) => c.item)).toEqual([1]);
    clock.t = 150; // 第一条就把预算跑光了
    resolvers[0].resolve("only");
    const out = await p;
    expect(calls.map((c) => c.item)).toEqual([1]); // 后三条一条都没起
    expect(out.results.filter(Boolean)).toEqual(["only"]);
    expect(out.done).toBe(1);
    expect(out.skipped).toBe(3);
    expect(out.timedOut).toBe(true);
  });

  it("每条 worker 拿到的是**剩余**预算，单条吃不光整份", async () => {
    const clock = { t: 0 };
    const { worker, calls, resolvers } = deferredWorker();
    const p = mapWithBudget([1, 2], worker, { concurrency: 1, budgetMs: 100, now: () => clock.t });
    await tick();
    expect(calls[0].remainingMs).toBe(100);
    clock.t = 40;
    resolvers[0].resolve("a");
    await tick();
    expect(calls[1].remainingMs).toBe(60);
    resolvers[1].resolve("b");
    await p;
  });

  it("单条抛错不连坐：那条记 null，其余照跑", async () => {
    const { worker, resolvers } = deferredWorker();
    const p = mapWithBudget([1, 2], worker, { concurrency: 2, budgetMs: 10_000 });
    await tick();
    resolvers[0].reject(new Error("模型 500"));
    resolvers[1].resolve("ok");
    const out = await p;
    expect(out.results).toEqual([null, "ok"]);
    expect(out.failed).toBe(1);
    expect(out.done).toBe(1);
  });

  it("空列表不调 worker；预算一开始就是 0 也一条不起", async () => {
    const { worker, calls } = deferredWorker();
    expect((await mapWithBudget([], worker, {})).results).toEqual([]);
    const out = await mapWithBudget([1, 2], worker, { budgetMs: 0 });
    expect(calls.length).toBe(0);
    expect(out.skipped).toBe(2);
    expect(out.timedOut).toBe(true);
  });
});
