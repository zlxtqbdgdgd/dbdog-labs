// backfill-root.mjs — 回刷时怎么构造要重推的 root span（2026-09-12 事故后提取成可测单元）。
//
// ## 事故
// 首版 backfill 直接推「本地 spans.jsonl 里的 root + 新图」。本地那份 root 的 tags
// 里**只有 hook 自己打的那些**（ml_app…）；服务端那份还有三个**服务端侧加的**：
//   · mcp_version / skills_digest —— mcp 边缘口转发时打的
//   · evaluation.verdict         —— 判题投影写的（llmobs_annotation_projection.go）
// 同键重发（ReplacingMergeTree 后写赢）把这三个全抹了：46 条 root 的判题裁决一次归零，
// 靠重发 95 条批注原件触发重投影才救回来（mcp_version/skills_digest 没救回来）。
//
// ## 为什么 graph-worker 那样写没事
// 它跑在 SessionEnd —— 那会儿还没判题，root 上的 evaluation.* 本来就是空的，覆盖的是空。
// 回刷是**判题之后**跑的，同一个动作就成了破坏。差别在时机，不在代码。
//
// ## 所以回刷必须以**服务端那份 root 为底**
// 只往它上面加 graph 再推回去。本地那份只用来算图，不作为推送载体。

/** 服务端侧加的 tag（本地 root 上不会有）——这些一旦被本地版覆盖就是数据损坏。 */
export const SERVER_SIDE_TAGS = ["mcp_version", "skills_digest", "evaluation."];

/** tag 键是不是服务端侧加的（evaluation.* 是前缀匹配，判题投影可能写多条）。 */
export function isServerSideTag(key) {
  const k = String(key ?? "");
  return SERVER_SIDE_TAGS.some((p) => (p.endsWith(".") ? k.startsWith(p) : k === p));
}

/** 读回参给的是 `ts_ms`（毫秒整数），摄入口要的是 `ts`（ISO 串）。不转就整条被拒。 */
export function withIngestTs(span) {
  if (!span || typeof span !== "object") return span;
  if (typeof span.ts === "string" && span.ts) return span;
  if (typeof span.ts_ms !== "number") return span;
  const { ts_ms, ...rest } = span;
  return { ...rest, ts: new Date(ts_ms).toISOString() };
}

/**
 * 构造要重推的 root span。
 * @param remote 服务端拉回来的 root span（**推送载体**，缺它就不许推）
 * @param graph  新算出来的紧凑图
 * @returns 可直接交给 reportSpans 的 span；remote 缺失返回 null（调用方据此跳过并报错）
 *
 * 只改 graph 一个字段：其余一律照抄服务端那份。本地 root 不参与——它没有服务端侧 tag，
 * 任何「以本地为底再补几个字段」的写法都会在下次新增服务端侧字段时再坏一遍。
 */
export function rootForBackfill(remote, graph) {
  if (!remote || typeof remote !== "object" || !remote.span_id || !remote.trace_id) return null;
  return withIngestTs({ ...remote, graph });
}

/**
 * 推之前的自检：拿要推的那份与服务端那份比，**服务端侧 tag 与既有正文字段**一个都不许少或变。
 * 返回被破坏的键列表（空数组 = 安全）。调用方应在非空时拒推。
 *
 * 为什么正文字段也要查：`spans/search` 的回参投影里**没有 model / intent**——照抄它推回去
 * 会把这两列抹空，与 tag 那个坑同一类（2026-09-12 首版事故的同族）。所以凡是服务端那份有值、
 * 要推的那份没有的字段，一律算破坏。
 */
const GUARDED_FIELDS = ["model", "intent", "input", "output", "name", "kind", "session_id", "parent_id", "duration_ms"];

export function serverTagDiff(remote, outgoing) {
  const a = remote?.tags ?? {};
  const b = outgoing?.tags ?? {};
  const bad = [];
  for (const [k, v] of Object.entries(a)) {
    if (!isServerSideTag(k)) continue;
    if (b[k] !== v) bad.push(k);
  }
  for (const f of GUARDED_FIELDS) {
    const has = remote?.[f] !== undefined && remote?.[f] !== null && remote?.[f] !== "";
    if (has && outgoing?.[f] !== remote[f]) bad.push(f);
  }
  return bad;
}
