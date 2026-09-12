// case-window.mjs — 复现时间窗怎么进题面。
//
// **和「题面禁止加料」不冲突**：加料指的是把我们的引导语（盲测规则、假设书写约定）塞进题面——
// 那些是 harness 的东西，塞进去测出来就不是产品面的真实行为了。时间窗不一样，它是**这条用例
// 自己的数据**：真实用户本来就会说「下午三点到四点有问题」，不说反而不像真实提问。
//
// 载体是 `record.metadata.repro`，由复现那一步写入（设计 §5 的入口接口）：
//   { instance, window_start, window_end, reproduced_at }
// 没有这一格就原样发题——**绝不编一个窗口出来**。

const TS = /^(\d{4}-\d{2}-\d{2})[ T](\d{2}):(\d{2})(?::(\d{2}))?/;

function parse(v) {
  const m = TS.exec(String(v ?? "").trim());
  if (!m) return null;
  return { date: m[1], h: m[2], min: m[3], sec: Number(m[4] ?? 0) };
}

/**
 * 复现记录 → 窗口短语，如 `2026-09-10 23:21:00–23:24:00(UTC+8)`。
 * 跨天时终点也带日期；缺起或缺止一律返回空（宁可不给窗口，也不给半个）。
 *
 * **到秒**（owner 2026-09-12：「这个地方没有显示秒」）。此前只到分钟、终点还要向上取整，
 * 理由是「题面里秒是噪音」；但复现窗口实际常常只有一两秒宽（活栈实测 19:18:45–19:18:46），
 * 截到分钟就把一个 1 秒的窗口说成了 1 分钟的——agent 按它去查会多捞一整分钟的无关数据。
 * 控制台侧的同款实现在 dbdog-web `src/lib/llmobs-repro-window.ts` 的 `promptWindowClause`，
 * 两处逐字对齐，改一处要同时改另一处。
 */
export function windowClause(repro) {
  const a = parse(repro?.window_start);
  const b = parse(repro?.window_end);
  if (!a || !b) return "";
  const tz = String(repro?.tz ?? "UTC+8");
  const hms = (p) => `${p.h}:${p.min}:${String(p.sec).padStart(2, "0")}`;
  const tail = a.date === b.date ? hms(b) : `${b.date} ${hms(b)}`;
  return `${a.date} ${hms(a)}–${tail}(${tz})`;
}

/** 窗口拼在题面最前，原题面一个字不改；题面已带窗口则不重复加。 */
export function promptWithWindow(prompt, repro) {
  const clause = windowClause(repro);
  if (!clause) return prompt;
  if (String(prompt).startsWith(clause)) return prompt;
  return `${clause}，${prompt}`;
}
