// probe.mjs（lib）— 探针的**纯逻辑**层：证据抽取、两腿判定、一致性。零 I/O、零 fetch。
//
// 探针是 D2 的第二件套：反向证据链说「这条根因本该在 dbdog 留下什么痕迹」，探针**真去查一遍**。
// 没有它，「模型没想到查 X」和「查了 X 但 dbdog 没采」在 trace 里长得一模一样，判题只能猜。
//
// **两条腿**：腿一走 mcp 工具（模型看到的那一面），腿二直查存储（真相）。两腿答案不一致 =
// dbdog 撒谎实锤——这是判「可信」开关的唯一硬证据；只走腿一遇到接口 bug 会拿到同一个错答案，
// 两腿一致只能证明「没抓到它撒谎」，证明不了数据对。
//
// outcome 四值与同事 skill `evidence-chain` 同口径（它的 ../dbdog-labs/skills/evidence-chain/scripts/check_chain.py 是守门）。
// **零模型**：这里只判「有没有数据」和「机器能不能核到期望里的字面量」，判不动的如实标出来，
// 留给判题模型拿 raw 预览复核——编一个 obtained_match 比留空更坏。

export const OUTCOMES = ["obtained_match", "obtained_mismatch", "empty_or_error", "no_tool"];
export const CONSISTENCY = ["consistent", "tool_bug_suspect", "data_absent", "not_probed"];

/**
 * 从反向链 JSON 里挑出「用 dbdog 工具取」的证据。
 * `source` 三选一（dbdog / local_source / unavailable）——只有 dbdog 那档能探；
 * `unavailable` 是反向链自己就说「目录里没工具」，探针不必再证一遍，但要原样带进产物。
 */
export function dbdogEvidence(chain) {
  const all = Array.isArray(chain?.evidence_chain) ? chain.evidence_chain : [];
  return all.filter((e) => e?.source === "dbdog" || e?.source === "unavailable");
}

/**
 * 证据的工具入参。反向链里 `params` 是**给人看的自由文本**（"入参（含窗）"），机器调不动；
 * 所以按顺序找可执行的那一份：显式 `args` 对象 → `params` 恰好是 JSON → 认输。
 * 认输不是失败：如实标 `skip_reason`，`outcome` 整项不填（四值都会是编的）。
 */
export function argsOf(evidence) {
  if (evidence?.args && typeof evidence.args === "object" && !Array.isArray(evidence.args)) return evidence.args;
  const raw = evidence?.params;
  if (typeof raw === "string" && /^\s*\{/.test(raw)) {
    try {
      const v = JSON.parse(raw);
      if (v && typeof v === "object" && !Array.isArray(v)) return v;
    } catch { /* 自由文本，下面认输 */ }
  }
  return null;
}

/** 时间窗兜底：证据没带 from/to 就用那次诊断的窗（trace 的首尾）。 */
export function withWindow(args, window) {
  if (!window?.from || !window?.to) return args;
  if (args.from || args.to) return args;
  return { ...args, from: window.from, to: window.to };
}

/** 期望里可机器核对的字面量：长度 ≥ 3 的词/数字，最多取 6 个。太短的词（"的" "up"）噪音大于信号。 */
export function expectTokens(expect) {
  if (typeof expect !== "string") return [];
  return [...new Set((expect.match(/[A-Za-z_][A-Za-z0-9_.]{2,}|\d[\d.]{2,}/g) ?? []))].slice(0, 6);
}

/**
 * 腿一的四值判定。`result` = `{ isError, text }`（text 是工具返回的文本块拼接）。
 * `known=false`（名字不在 tools/list）直接 `no_tool`——判据与 evidence-chain 一致。
 */
export function toolOutcome({ known, result, expect }) {
  if (!known) return { outcome: "no_tool", basis: "名字不在 tools/list" };
  if (!result || result.error) return { outcome: "empty_or_error", basis: `调用失败：${result?.error ?? "无返回"}` };
  const text = String(result.text ?? "");
  if (result.isError) return { outcome: "empty_or_error", basis: `工具回错：${text.slice(0, 200)}` };
  if (text.includes("capability_unavailable")) return { outcome: "empty_or_error", basis: "结构化缺口 capability_unavailable" };
  if (!text.trim() || /^\s*(\{\s*\}|\[\s*\]|\{"[a-z_]+":\s*\[\s*\]\s*\})\s*$/.test(text)) {
    return { outcome: "empty_or_error", basis: "返回空集" };
  }
  const tokens = expectTokens(expect);
  if (tokens.length === 0) return { outcome: "obtained_match", basis: "有数据；期望里没有可机器核对的字面量（match_basis=non_empty）" };
  const hit = tokens.filter((t) => text.includes(t));
  return hit.length > 0
    ? { outcome: "obtained_match", basis: `有数据，命中期望字面量 ${hit.join(", ")}` }
    : { outcome: "obtained_mismatch", basis: `有数据，但期望的 ${tokens.join(", ")} 一个都没出现` };
}

/**
 * 两腿一致性。腿二没跑（没有 direct_query / 直查口不在 / 直查自己报错）一律 `not_probed`——
 * 「没查过」不许伪装成「一致」，否则「没有工具错」会被一堆没验过的证据顶出来。
 */
export function consistencyOf(toolLeg, directLeg) {
  if (!directLeg || directLeg.status !== "ok") return "not_probed";
  const toolHas = toolLeg?.outcome === "obtained_match" || toolLeg?.outcome === "obtained_mismatch";
  const directHas = (directLeg.rows ?? 0) > 0;
  if (!toolHas && !directHas) return "data_absent";
  if (toolHas !== directHas) return "tool_bug_suspect";
  return toolLeg.outcome === "obtained_mismatch" ? "tool_bug_suspect" : "consistent";
}

/** trace.json → `{from,to}`（RFC3339），供没带窗的证据兜底。 */
export function windowOfTrace(trace) {
  const spans = trace?.spans ?? [];
  const ts = spans.map((s) => s.ts_ms).filter((n) => typeof n === "number" && n > 0);
  if (!ts.length) return null;
  const from = Math.min(...ts);
  const last = Math.max(...spans.map((s) => (s.ts_ms ?? 0) + (s.duration_ms ?? 0)));
  return { from: new Date(from - 60_000).toISOString(), to: new Date(last + 60_000).toISOString() };
}

/**
 * 跑一条证据的两条腿。`callTool(name,args)` 回 `{isError,text}` 或 `{error}`；
 * `directQuery(spec)` 回 `{status:"ok",rows,preview}` / `{status:"unavailable"|"error",detail}`。
 */
export async function probeOne(evidence, { knownTools, callTool, directQuery, window }) {
  const id = evidence.id ?? "?";
  const out = { id, name: evidence.name ?? "", tier: evidence.tier ?? "", tool: evidence.tool ?? null, source: evidence.source };

  if (evidence.source === "unavailable") {
    out.tool_leg = { outcome: "no_tool", basis: "反向链自述：目录里没有能取这条证据的工具", needed_capability: evidence.needed_capability ?? "" };
  } else if (!evidence.tool) {
    out.tool_leg = { probed: false, skip_reason: "反向链里这条证据没写工具名" };
  } else if (!knownTools.has(evidence.tool)) {
    out.tool_leg = { outcome: "no_tool", basis: "名字不在 tools/list", tool: evidence.tool };
  } else {
    const args = argsOf(evidence);
    if (!args) {
      out.tool_leg = { probed: false, skip_reason: "入参是自由文本，机器调不动（反向链里给 args 对象才能探）" };
    } else {
      const finalArgs = withWindow(args, window);
      const result = await callTool(evidence.tool, finalArgs);
      out.tool_leg = { ...toolOutcome({ known: true, result, expect: evidence.expect_in_output }), args: finalArgs, preview: String(result?.text ?? "").slice(0, 600) };
    }
  }

  const spec = evidence.direct_query;
  if (!spec || typeof spec !== "object") {
    out.direct_leg = { status: "skipped", detail: "这条证据没带 direct_query（{store,sql,args}）" };
  } else if (!directQuery) {
    out.direct_leg = { status: "skipped", detail: "本次没开直查腿" };
  } else {
    out.direct_leg = await directQuery(spec);
  }

  out.consistency = out.tool_leg?.outcome ? consistencyOf(out.tool_leg, out.direct_leg) : "not_probed";
  return out;
}

/** 汇总一行给人看的话。 */
export function summarize(evidences) {
  const count = (pred) => evidences.filter(pred).length;
  return {
    total: evidences.length,
    obtained_match: count((e) => e.tool_leg?.outcome === "obtained_match"),
    obtained_mismatch: count((e) => e.tool_leg?.outcome === "obtained_mismatch"),
    empty_or_error: count((e) => e.tool_leg?.outcome === "empty_or_error"),
    no_tool: count((e) => e.tool_leg?.outcome === "no_tool"),
    not_probed: count((e) => !e.tool_leg?.outcome),
    tool_bug_suspect: count((e) => e.consistency === "tool_bug_suspect"),
    data_absent: count((e) => e.consistency === "data_absent"),
    consistent: count((e) => e.consistency === "consistent"),
  };
}
