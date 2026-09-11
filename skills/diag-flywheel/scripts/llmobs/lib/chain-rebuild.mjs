// chain-rebuild.mjs — 重建链：评测方用一次模型调用，把 agent **声明的**假设树读成**语义上的**因果链。
//
// 为什么要有这一步（owner 2026-09-11）：线上三条 trace 的账本全是一排一级假设，`parent_edges=0`，
// 但报告正文里都能读出多环的因果链——模型把「沿链往下」写成了「再开一个并列」（OG-7458 的 H6 其实是
// H3 那个桶里的具体机制，H3 却被判证伪），或把三步链压成一条复合 claim（OG-7284 的 H2）。
// 账本因此不能当「结论对不对」的依据。判卷前先把语义树重建出来，和声明树并排给判卷方看。
//
// 边界（与 judge-package.mjs 文件头的规矩一致）：
//   · forward.md 只认 span tags、不猜；本文件产出的是**评测方的猜**，单独落 chain.json / chain.md，
//     不并进 forward.md，不改任何声明侧的判定。
//   · 一条 case 一次模型调用；材料不扫全部 span，只要声明树 + 正文 Propose 行 + 账本 + 报告。
//   · 失败就返回 failed / skipped，不抛、不阻塞判卷（判卷包里少一份材料而已）。
//   · 深度、冲突这类派生量**自己算**，不信模型报的数。
//
// 声明树的解析走 claude-code-hooks/hypothesis-graph.mjs（hook 出图的唯一实现），不在这里再写一份解析器。
import fs from "node:fs";
import path from "node:path";
import { agentConclusion, build, compactGraph, dedupe, scanProposals } from "../../../../../claude-code-hooks/hypothesis-graph.mjs";

export const CHAIN_VERSION = 1;
export const CHAIN_FILES = { json: "chain.json", md: "chain.md" };

/**
 * 节点与 `semantic_parent` 的关系词表（只认这四个）：
 *   root         没有语义上的父（一级）
 *   explains     本节点是 semantic_parent 的下一环（机制链：回答「父为什么成立」）——深度 +1
 *   refines      本节点是 semantic_parent 的具体情形（粗→细：父是一个粗桶，本节点是桶里的一条具体机制）——深度 +1
 *   alternative  本节点是 semantic_parent 的竞争解释（同一层的并列）——深度同父
 *   same_as      本节点与 semantic_parent 是同一个 claim 换了说法——深度同父，不算新节点
 *
 * 深度口径：**现象确认节点是根、不占层**（与控制台假设图「现象 → 一级假设扇出」同一语义）；直接解释现象的根因是第 1 层。
 * 判定不影响谱系：父被判证伪，桶里的具体机制仍是它的 refines——这正是要暴露的冲突。
 */
export const RELATIONS = ["root", "explains", "refines", "alternative", "same_as"];
const DEEPENS = new Set(["explains", "refines"]);
const isSymptomType = (t) => t === "confirm" || t === "symptom";

const FIVE_HEADINGS = /^\s*##\s*(What happened|Why that broke things|The root cause|What to do to fix|How do we know)/gim;
const LEDGER_HEAD = /^\s*(?:#{1,6}\s*)?\**\s*(?:hypothesis ledger|假设收口)\s*\**\s*:?\s*$/i;
const VERDICT_ZH = { confirmed: "证实", falsified: "证伪", open: "未决" };
const TYPE_ZH = { confirm: "现象确认", symptom: "现象确认", cause: "根因" };

function outputOf(s) {
  const o = typeof s.output_local === "string" ? s.output_local : s.output;
  if (typeof o === "string") return o;
  return o ? JSON.stringify(o) : "";
}

/** 报告正文：agent/llm span 里五段式标题最多的那条；都没有就退到 root 结论（hook 同一口径）。 */
export function reportText(spans) {
  let best = { n: 0, text: "" };
  for (const s of spans) {
    if (s.kind !== "agent" && s.kind !== "llm") continue;
    const text = outputOf(s);
    if (!text.trim()) continue;
    const n = (text.match(FIVE_HEADINGS) ?? []).length;
    if (n >= 3 && (n > best.n || (n === best.n && text.length > best.text.length))) best = { n, text };
  }
  return best.text || agentConclusion(spans) || "";
}

/** 账本小节的原文行（到下一个标题为止）。 */
export function ledgerLines(text) {
  const lines = String(text ?? "").split("\n");
  const out = [];
  let inside = false;
  for (const raw of lines) {
    const line = raw.trim();
    if (LEDGER_HEAD.test(line)) {
      inside = true;
      continue;
    }
    if (!inside) continue;
    if (/^#{1,6}\s/.test(line)) break;
    if (!line) continue;
    out.push(line.replace(/^[-*|]\s*/, "").replace(/\*\*/g, ""));
  }
  return out;
}

/**
 * 从 server 导出的 spans 凑齐重建材料。没有任何假设编号返回 null。
 * @returns {{
 *   trace_id: string,
 *   declared: {id, parent, type, claim, expect, verdict, first_seq, calls, proposed_in, prose_claim}[],
 *   symptom: string,
 *   ledger: string[],
 *   report: string,
 *   conclusion: string,
 * } | null}
 */
export function chainMaterials(spans) {
  const list = dedupe(Array.isArray(spans) ? spans : []);
  if (!list.length) return null;
  const g = compactGraph(build(list));
  if (!g.nodes?.length) return null;

  // 正文提出时的 claim（可能与调用里写的不一样——同一编号两套说法就是 claim 漂移的线索）
  const prose = new Map();
  for (const s of list) {
    if (s.kind === "tool") continue;
    for (const [hid, p] of scanProposals(outputOf(s))) if (p.text && !prose.has(hid)) prose.set(hid, p.text);
  }

  const declared = g.nodes
    .map((n) => ({
      id: n.id,
      parent: n.parent ?? null,
      type: n.type ?? null,
      claim: n.text ?? "",
      expect: n.expect ?? "",
      verdict: n.verdict ?? "open",
      first_seq: n.first_seq ?? null,
      calls: Array.isArray(n.calls) ? n.calls.length : 0,
      proposed_in: n.proposed_in?.in ?? null,
      prose_claim: prose.get(n.id) && prose.get(n.id) !== n.text ? prose.get(n.id) : null,
    }))
    .sort((a, b) => a.id.localeCompare(b.id, undefined, { numeric: true }));

  const report = reportText(list);
  const symptom = declared.find((n) => n.type === "confirm" || n.type === "symptom")?.claim ?? "";
  return {
    trace_id: g.trace_ids?.[0] ?? list.find((s) => s.trace_id)?.trace_id ?? "",
    declared,
    symptom,
    ledger: ledgerLines(report),
    report,
    conclusion: agentConclusion(list) || "",
  };
}

const clip = (s, n) => {
  const t = String(s ?? "").replace(/\s+/g, " ").trim();
  return t.length > n ? `${t.slice(0, n - 1)}…` : t;
};

const REPORT_CAP = 14000;

/**
 * 提示词。**不举带编号的例子**：示例编号会被模型抄进输出（2026-09-10 实测 skill 里的 `H2.1` 示例被当成真提出）。
 * 形状用 <占位> 说明，编号只能从材料里列出的挑。
 */
export function buildChainPrompt(m) {
  const ids = m.declared.map((n) => n.id);
  const nodeLines = m.declared.map((n) => {
    const parts = [
      `[${n.id}]`,
      n.type ? `类型=${TYPE_ZH[n.type] ?? n.type}` : "类型未写",
      `声明的父=${n.parent ?? "无"}`,
      `判定=${VERDICT_ZH[n.verdict] ?? n.verdict}`,
      n.first_seq != null ? `第 ${n.first_seq} 次 dbdog 调用提出` : "只在正文提出、没取证",
      `取证 ${n.calls} 次`,
    ];
    const lines = [`- ${parts.join("；")}`, `  claim：${clip(n.claim, 600) || "（缺）"}`];
    if (n.prose_claim) lines.push(`  正文提出时写的 claim（与调用里不同）：${clip(n.prose_claim, 600)}`);
    if (n.expect) lines.push(`  判据：${clip(n.expect, 400)}`);
    return lines.join("\n");
  });
  const report = m.report.length > REPORT_CAP ? `${m.report.slice(0, REPORT_CAP)}\n…（报告截断）` : m.report;

  return `你是数据库诊断的评测方。下面是一次诊断里 agent **声明的**假设账本和它最后写的报告。
账本是平铺的：每个编号都是一级。你的任务是读懂它们之间**语义上的**因果关系，把链重建出来。

只做判断，不做诊断，不评价对错。编号只能从下面列出的里选，一个都不能多、一个都不能少。

## 现象
${clip(m.symptom, 600) || "（账本里没有现象确认节点）"}

## 声明的假设（按编号）
${nodeLines.join("\n")}

## 账本收口（报告结尾）
${m.ledger.length ? m.ledger.map((l) => `- ${l}`).join("\n") : "（报告里没有收口小节）"}

## 报告正文
${report || "（没有报告正文）"}

## 你要回答的
对每个编号给出：
- semantic_parent：语义上它解释的是哪个编号；一级填 null。
- relation：与 semantic_parent 的关系，只能是这五个词之一：
  root（没有父）／explains（它是父的下一环，回答「父为什么成立」）／refines（父是一个粗桶，它是桶里的一条具体机制或具体情形）／alternative（它是父的竞争解释，同一层并列）／same_as（它和父是同一个 claim 换了说法）。
  判断标准：A 的 claim 成立需要 B 的 claim 作为机制或前提 → B explains A；A 说的是一类原因、B 是这一类里的一个具体机制 → B refines A；A 和 B 解释同一个现象但互斥或并列 → alternative；两段话说的是同一件事 → same_as。
  粗桶 claim 里括号内的枚举当例子、不当穷举：判 refines 看粗桶的主句说的是哪一类原因，不看例子列没列到。
  **判定不影响谱系**：粗桶被判证伪、桶里的具体机制却被判证实，这正是要暴露的矛盾，照样填 refines，不要因为父证伪就把子挂到别处。
  **现象确认节点是根**：直接解释现象的根因假设，semantic_parent 填现象节点的编号、relation 填 explains；没有现象节点的，一级根因填 null / root。
- claim_drift：这个编号的 claim 在诊断过程中有没有换成另一件事（正文提出的和调用里写的不是一回事、或收口时讲的和提出时不同）。true/false；true 时在 drift_note 用一句话说明。
再给出：
- final_mechanism_node：报告最终认定的根因机制落在哪个编号上；报告的机制不属于任何编号就填 null。
- notes：不超过 200 字，说重建时最要紧的一点。

只输出一个 JSON 对象，不要任何解释、不要 markdown 围栏。形状：
{"nodes":[{"id":"<编号>","semantic_parent":"<编号或 null>","relation":"<四个词之一>","claim_drift":<true/false>,"drift_note":"<可空>"}],"final_mechanism_node":"<编号或 null>","notes":"<一句话>"}

编号清单：${ids.join("、")}`;
}

function extractJson(text) {
  const t = String(text ?? "").trim();
  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(t);
  const body = fenced ? fenced[1] : t;
  const a = body.indexOf("{");
  const b = body.lastIndexOf("}");
  if (a < 0 || b <= a) throw new Error(`模型没有回 JSON：${clip(t, 120)}`);
  try {
    return JSON.parse(body.slice(a, b + 1));
  } catch (e) {
    throw new Error(`模型回的 JSON 解析失败（${e.message}）：${clip(t, 120)}`);
  }
}

/** 沿 semantic_parent 往上数：现象节点 0；explains / refines 每跨一层 +1；alternative / same_as 与父同层（根因至少 1）。 */
function semanticDepthOf(byId, id, guard = new Set()) {
  const n = byId.get(id);
  if (!n) return 1;
  if (n.is_symptom) return 0;
  if (!n.semantic_parent) return 1;
  if (guard.has(id)) throw new Error(`semantic_parent 成环：${[...guard, id].join(" → ")}`);
  guard.add(id);
  const up = semanticDepthOf(byId, n.semantic_parent, guard);
  return Math.max(1, DEEPENS.has(n.relation) ? up + 1 : up);
}

function declaredDepthOf(byId, id, guard = new Set()) {
  const n = byId.get(id);
  if (!n) return 1;
  if (isSymptomType(n.type)) return 0;
  if (!n.parent || !byId.has(n.parent) || guard.has(id)) return 1;
  guard.add(id);
  return Math.max(1, declaredDepthOf(byId, n.parent, guard) + 1);
}

/**
 * 校验模型的回答并派生深度 / 冲突。任何一处不合形状就整份抛掉——宁缺毋滥。
 * @param {string} text 模型原话
 * @param {ReturnType<typeof chainMaterials>} m 材料（声明树是校验的基准）
 */
export function parseChainResponse(text, m) {
  const raw = extractJson(text);
  if (!raw || typeof raw !== "object" || !Array.isArray(raw.nodes)) throw new Error("模型回的 JSON 没有 nodes 数组");
  const declaredById = new Map(m.declared.map((n) => [n.id, n]));

  const seen = new Set();
  const nodes = [];
  for (const rn of raw.nodes) {
    const id = String(rn?.id ?? "").trim();
    if (!declaredById.has(id)) throw new Error(`模型编了声明树里没有的编号 ${id || "(空)"}`);
    if (seen.has(id)) throw new Error(`编号 ${id} 出现了两次`);
    seen.add(id);
    const relation = String(rn.relation ?? "").trim();
    if (!RELATIONS.includes(relation)) throw new Error(`编号 ${id} 的 relation「${relation}」不在词表 ${RELATIONS.join("/")} 里`);
    const parent = rn.semantic_parent == null || rn.semantic_parent === "" ? null : String(rn.semantic_parent).trim();
    if (parent !== null && !declaredById.has(parent)) throw new Error(`编号 ${id} 的 semantic_parent ${parent} 不在声明树里`);
    if (parent === id) throw new Error(`编号 ${id} 的 semantic_parent 指向自己（成环）`);
    if (relation === "root" && parent !== null) throw new Error(`编号 ${id} relation=root 却有 semantic_parent ${parent}`);
    if (relation !== "root" && parent === null) throw new Error(`编号 ${id} relation=${relation} 却没有 semantic_parent`);
    const d = declaredById.get(id);
    nodes.push({
      id,
      claim: d.claim,
      semantic_parent: parent,
      relation,
      claim_drift: Boolean(rn.claim_drift),
      drift_note: rn.claim_drift && rn.drift_note ? String(rn.drift_note) : null,
      declared_parent: d.parent ?? null,
      declared_verdict: d.verdict,
      is_symptom: isSymptomType(d.type),
    });
  }
  const missing = m.declared.map((n) => n.id).filter((id) => !seen.has(id));
  if (missing.length) throw new Error(`模型漏了声明树里的编号：${missing.join("、")}`);

  const byId = new Map(nodes.map((n) => [n.id, n]));
  for (const n of nodes) semanticDepthOf(byId, n.id); // 成环在这里抛
  const depthSemantic = Math.max(0, ...nodes.map((n) => semanticDepthOf(byId, n.id)));
  const depthDeclared = Math.max(0, ...nodes.map((n) => declaredDepthOf(declaredById, n.id)));

  let finalNode = raw.final_mechanism_node == null || raw.final_mechanism_node === "" ? null : String(raw.final_mechanism_node).trim();
  if (finalNode !== null && !declaredById.has(finalNode)) throw new Error(`final_mechanism_node ${finalNode} 不在声明树里`);

  const conflicts = [];
  for (const n of nodes) {
    if (!DEEPENS.has(n.relation)) continue;
    const p = byId.get(n.semantic_parent);
    if (p.declared_verdict === "falsified" && n.declared_verdict === "confirmed") {
      conflicts.push({ kind: "parent_refuted_child_supported", parent: p.id, child: n.id });
    }
  }
  if (finalNode && byId.get(finalNode).declared_verdict === "falsified") {
    conflicts.push({ kind: "final_mechanism_refuted", node: finalNode });
  }

  return {
    version: CHAIN_VERSION,
    trace_id: m.trace_id,
    nodes: nodes.sort((a, b) => a.id.localeCompare(b.id, undefined, { numeric: true })),
    final_mechanism_node: finalNode,
    depth_declared: depthDeclared,
    depth_semantic: depthSemantic,
    conflicts,
    notes: typeof raw.notes === "string" ? raw.notes.slice(0, 400) : "",
  };
}

const RELATION_ZH = { root: "一级", explains: "解释父", refines: "细化父", alternative: "与父并列", same_as: "与父同一 claim" };

/** chain.md：语义树缩进列表 + 冲突 + 说明。给判卷方和人读；机器读 chain.json。 */
export function renderChain(c, m) {
  const byId = new Map(c.nodes.map((n) => [n.id, n]));
  const kids = new Map();
  for (const n of c.nodes) {
    // 挂到语义父下面的是 explains / refines；alternative / same_as 与父同层，排在父旁边
    const parentOf = (x) => (x.relation === "root" ? null : DEEPENS.has(x.relation) ? x.semantic_parent : parentOf(byId.get(x.semantic_parent)));
    const key = parentOf(n);
    if (!kids.has(key)) kids.set(key, []);
    kids.get(key).push(n);
  }
  const lines = [];
  lines.push("# 重建链：评测方读出来的语义因果链");
  lines.push("");
  lines.push(`- trace：\`${c.trace_id || "—"}\`　这是**评测方用模型重建的**，不是 agent 的声明；声明树见 forward.md。两者冲突时两边都报，不以本文件改声明侧的判定。`);
  lines.push(`- 声明深度 ${c.depth_declared}　重建深度 ${c.depth_semantic}　最终机制落在 ${c.final_mechanism_node ? `[${c.final_mechanism_node}]` : "（不属于任何编号）"}`);
  lines.push("");
  lines.push("## 语义树");
  lines.push("");
  const walk = (parentKey, depth) => {
    const list = (kids.get(parentKey) ?? []).sort((a, b) => a.id.localeCompare(b.id, undefined, { numeric: true }));
    for (const n of list) {
      const pad = "  ".repeat(depth);
      const flags = [];
      if (n.relation !== "root" && n.relation !== "explains") flags.push(`${RELATION_ZH[n.relation]} [${n.semantic_parent}]`);
      if (n.claim_drift) flags.push(`claim 漂移${n.drift_note ? `：${clip(n.drift_note, 80)}` : ""}`);
      if (n.is_symptom) flags.push("现象，根");
      if (c.final_mechanism_node === n.id) flags.push("最终机制");
      lines.push(`${pad}- **[${n.id}]** ${clip(n.claim, 120) || "（claim 缺）"}　— 声明判定 ${VERDICT_ZH[n.declared_verdict] ?? n.declared_verdict}${flags.length ? `　（${flags.join("；")}）` : ""}`);
      walk(n.id, depth + 1); // 并列 / 同义节点也可能有自己的下一环（8252：H3 explains H2，而 H2 是 H1 的 alternative）
    }
  };
  walk(null, 0);
  lines.push("");
  lines.push("## 判定冲突");
  lines.push("");
  if (!c.conflicts.length) lines.push("（没有：语义父子之间的声明判定不打架）");
  for (const x of c.conflicts) {
    if (x.kind === "parent_refuted_child_supported") lines.push(`- [${x.parent}] 被判证伪，而解释它的 [${x.child}] 被判证实——父桶证伪、桶里的具体机制证实，账本自相矛盾`);
    else if (x.kind === "final_mechanism_refuted") lines.push(`- 报告最终机制落在 [${x.node}]，账本却把它判成证伪`);
  }
  lines.push("");
  if (c.notes) {
    lines.push("## 重建说明");
    lines.push("");
    lines.push(c.notes);
    lines.push("");
  }
  return lines.join("\n");
}

function readSpans(caseDir) {
  const p = path.join(caseDir, "trace.json");
  if (!fs.existsSync(p)) return null;
  const j = JSON.parse(fs.readFileSync(p, "utf8"));
  return Array.isArray(j) ? j : Array.isArray(j?.spans) ? j.spans : null;
}

/**
 * 一条 case 一次模型调用。成败都不抛：
 *   ok      写了 chain.json + chain.md
 *   skipped trace.json 缺 / 没有假设编号——重建无从谈起
 *   failed  模型没回可用的 JSON（reason 里带原因），不落文件
 * @param {{ caseDir: string, runAgent: (o:{prompt:string}) => Promise<{prose:string}>, model?: string }} o
 */
export async function rebuildChain({ caseDir, runAgent, model }) {
  const spans = readSpans(caseDir);
  if (!spans) return { status: "skipped", reason: "trace.json 缺或不成形" };
  const m = chainMaterials(spans);
  if (!m) return { status: "skipped", reason: "trace 里没有任何假设编号" };
  const prompt = buildChainPrompt(m);
  let prose = "";
  try {
    const res = await runAgent({ prompt });
    prose = String(res?.prose ?? "");
  } catch (e) {
    return { status: "failed", reason: `模型调用失败：${e?.message ?? e}` };
  }
  let chain;
  try {
    chain = parseChainResponse(prose, m);
  } catch (e) {
    return { status: "failed", reason: e?.message ?? String(e) };
  }
  const out = { ...chain, model: model || process.env.ANTHROPIC_MODEL || "default", rebuilt_at: new Date().toISOString() };
  fs.writeFileSync(path.join(caseDir, CHAIN_FILES.json), JSON.stringify(out, null, 1));
  fs.writeFileSync(path.join(caseDir, CHAIN_FILES.md), renderChain(out, m));
  return { status: "ok", depth_declared: out.depth_declared, depth_semantic: out.depth_semantic, conflicts: out.conflicts.length };
}
