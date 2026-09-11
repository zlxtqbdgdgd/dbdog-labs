// run-status.mjs — 一轮跑完该把 experiment 的 status 写成什么。
//
// 为什么要有它（飞轮 §13.2 #7 实证）：`diag-causal-chain` 三条跑完，控制面里 status 仍是
// `running`——建行时置的初值从来没人改过。读侧因此只能「不拿 status 判轮次完没完」，
// 于是「跑完了」「还在跑」「跑挂了」三种在页面上长一个样。
//
// **轮次级与用例级不许搅在一起**（§13.2 #3 刚把它们分开）：个别用例跑挂了是用例级事实，
// 已经写在那条 event 的 `status` 上；轮次照样是「跑完了」。只有整轮没产出任何可用结果
// （一条都没跑成 / 一条用例都没有 / 顶层异常没跑到收尾）才算轮次失败。
//
// 取值受 server 的 CHECK 约束：`status IN ('running','completed','failed','interrupted')`。

/** server 侧 CHECK 约束的全集，顺序即语义顺序（初值 → 终态三种）。 */
export const RUN_STATUSES = ["running", "completed", "failed", "interrupted"];

/**
 * @param {{ total: number, errored: number, signal?: string|null, crashed?: boolean }} o
 *   total   本轮实际跑了几条用例
 *   errored 其中报错的几条（用例级）
 *   signal  收到过哪个终止信号（SIGINT / SIGTERM）
 *   crashed 顶层异常，没跑到收尾
 * @returns {"completed"|"failed"|"interrupted"}
 */
export function runStatusOf({ total, errored, signal = null, crashed = false }) {
  // 信号优先：被人按停 / 被 launchd 杀掉，跟「跑完了但结果不好」是两回事。
  if (signal) return "interrupted";
  if (crashed) return "failed";
  if (!Number.isFinite(total) || total <= 0) return "failed";   // 空转不算跑完
  return errored >= total ? "failed" : "completed";
}
