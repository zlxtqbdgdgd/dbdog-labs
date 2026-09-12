#!/usr/bin/env node
// backfill-graphs.mjs — 历史 trace 回刷：重跑代码证据两段 → 重建图 → root 带新图重推 server。
//
// 为什么要回刷：代码证据（source-evidence 两段）是 2026-09-12 才加的，此前跑完的 trace
// 图里没有这一类边。原始 span 都还在本地 spans.jsonl 里，重算一遍即可——不用等新 trace。
// 推的是 root span 同键重插（Replacing 后写赢，与判题投影 evaluation.* 同一机制）。
//
// 用法：node backfill-graphs.mjs <spans.jsonl 或含它的目录>... [--dry-run] [--trace <前缀>]
// env：模型走 summaryEnv()（DBDOG_SUMMARY_LLM_* / ANTHROPIC_*）；上报走 DBDOG_OBS_REPORT_URL
//      + DBDOG_OBS_API_KEY；**读服务端 root 走 DBDOG_BASE_URL + DBDOG_API_KEY（必需）**。
//      缺模型 env 则只重建不产代码证据；拉不到服务端 root 一律跳过，绝不用本地版顶替。
import fs from "node:fs";
import path from "node:path";
import { build, compactGraph, dedupe } from "./hypothesis-graph.mjs";
import { sourceEvidenceCandidates } from "./source-evidence.mjs";
import { buildSourceEvidencePrompt, parseSourceEvidenceReply } from "./source-evidence-prompt.mjs";
import { generateSummary, summaryEnv } from "./summary.mjs";
import { reportSpans } from "./lib.mjs";
import { rootForBackfill, serverTagDiff } from "./backfill-root.mjs";

/**
 * 从服务端拉这条 trace 的 root span —— 它是重推的**唯一**合法载体。
 * 走 `GET /trace/{id}`（整条 trace）而不是 `spans/search`：后者的回参投影里**没有
 * model / intent**，照抄推回去会把这两列抹空（与 tag 那个坑同族）。
 */
async function remoteRoot(traceId) {
  const base = (process.env.DBDOG_BASE_URL ?? "").replace(/\/+$/, "");
  const key = process.env.DBDOG_API_KEY ?? process.env.DBDOG_OBS_API_KEY ?? "";
  if (!base || !key) return null;
  const res = await fetch(`${base}/api/v2/llmobs/trace/${encodeURIComponent(traceId)}`, {
    headers: { "DD-API-KEY": key },
  }).catch(() => null);
  if (!res?.ok) return null;
  const body = await res.json().catch(() => null);
  return (body?.spans ?? []).find((s) => s.kind === "agent" && !s.parent_id) ?? null;
}

const args = process.argv.slice(2);
const DRY = args.includes("--dry-run");
const only = args[args.indexOf("--trace") + 1] && args.includes("--trace") ? args[args.indexOf("--trace") + 1] : "";
const inputs = args.filter((a) => !a.startsWith("--") && a !== only);

function filesUnder(p) {
  const st = fs.statSync(p);
  if (st.isFile()) return [p];
  const out = [];
  for (const d of fs.readdirSync(p)) {
    const f = path.join(p, d);
    try {
      if (fs.statSync(f).isDirectory()) out.push(...filesUnder(f));
      else if (d === "spans.jsonl") out.push(f);
    } catch { /* 读不到就跳过 */ }
  }
  return out;
}

const byTrace = new Map();
for (const inp of inputs) {
  for (const f of filesUnder(inp)) {
    for (const line of fs.readFileSync(f, "utf8").split("\n")) {
      if (!line) continue;
      let s;
      try { s = JSON.parse(line); } catch { continue; }
      if (!s.trace_id || (only && !s.trace_id.startsWith(only))) continue;
      if (!byTrace.has(s.trace_id)) byTrace.set(s.trace_id, []);
      byTrace.get(s.trace_id).push(s);
    }
  }
}

const env = summaryEnv();
if (!env) console.error("⚠ 没配模型 env——只重建图，不产代码证据");
console.error(`共 ${byTrace.size} 条 trace${DRY ? "（dry-run，不推）" : ""}`);

let pushed = 0, failed = 0, edges = 0, withEv = 0;
for (const [trace, raw] of byTrace) {
  const spans = dedupe(raw);
  const root = spans.find((s) => s.kind === "agent" && !s.parent_id);
  if (!root) { console.error(`  ${trace.slice(0, 10)} 没有 root span，跳过`); continue; }
  const sourceEvidence = {}, sourceVerdict = {};
  if (env) {
    for (const c of sourceEvidenceCandidates(spans)) {
      const prompt = buildSourceEvidencePrompt(c);
      if (!prompt) continue;
      try {
        const r = await generateSummary([{ role: "user", content: prompt }], { ...env, maxTokens: 1500 });
        const g = parseSourceEvidenceReply(r?.text ?? r);
        if (!g) continue;
        if (g.steps.length) sourceEvidence[g.id] = [...(sourceEvidence[g.id] ?? []), ...g.steps];
        if (c.verdict && !sourceVerdict[g.id]) sourceVerdict[g.id] = c.verdict;
      } catch (e) { console.error(`  ${trace.slice(0, 10)} 判切分失败：${e?.message ?? e}`); }
    }
  }
  const g = build(spans, { sourceEvidence, sourceVerdict });
  const n = g.summary.source_edges ?? 0;
  edges += n;
  if (n) withEv += 1;
  const graph = compactGraph(g);
  if (DRY) { console.error(`  ${trace.slice(0, 10)} 假设 ${g.summary.hypotheses} 工具边 ${g.summary.tool_edges} 代码证据边 ${n}（未推）`); continue; }
  const rr = await remoteRoot(trace);
  const outgoing = rootForBackfill(rr, graph);
  if (!outgoing) {
    failed += 1;
    console.error(`  ${trace.slice(0, 10)} 拉不到服务端的 root（缺 DBDOG_BASE_URL/DBDOG_API_KEY？）——跳过，不用本地版顶替`);
    continue;
  }
  const bad = serverTagDiff(rr, outgoing);
  if (bad.length) {
    failed += 1;
    console.error(`  ${trace.slice(0, 10)} 自检不过，会抹掉服务端侧 tag：${bad.join(", ")}——拒推`);
    continue;
  }
  const ok = await reportSpans([outgoing]);
  if (ok) pushed += 1; else failed += 1;
  console.error(`  ${trace.slice(0, 10)} 假设 ${g.summary.hypotheses} 工具边 ${g.summary.tool_edges} 代码证据边 ${n} → ${ok ? "已推" : "推失败"}`);
}
console.error(`\n合计：${byTrace.size} 条 · 有代码证据 ${withEv} 条 · 代码证据边 ${edges} · 已推 ${pushed} · 失败 ${failed}`);
