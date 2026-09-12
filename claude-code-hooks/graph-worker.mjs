#!/usr/bin/env node
// graph-worker.mjs — SessionEnd 之后自动出假设图的 detached worker（2026-09-10，owner 定：
// 「hook 把 span-graph 的能力带上」——装了插件就有图，不用再手动跑 skill）。
// 由 session-end.mjs 在本 trace 收尾之后 spawn({detached:true}).unref() 起本进程：
//   ① 读本 trace 的 span（流式，只留本 trace）→ hypothesis-graph.mjs 出图 →
//      写到 <obsDir>/graphs/<trace_id>/forward-path.{md,json}（全量，含每次调用入参/返回）+ forward-conclusion.md；
//   ② 把**紧凑形**的图挂在 root span 上，随 root 同键重发到 server（POST /api/v2/llmobs/spans，与判题投影往 root
//      加 evaluation.* tag 同一机制，Replacing 后写赢）——server 存 root 行的 graph 列，web / 判题包读
//      GET /api/v2/llmobs/trace/{id}/graph，不再各自从 4MB span 现算。没配上报 env 就只做 ①。
// 重入幂等：同 trace 覆盖同一目录、同一 root 行。best-effort：任何失败只在 graph-worker.log 留一行。
// 用法：node graph-worker.mjs <sessionId>
import fs from "node:fs";
import path from "node:path";
import { obsDir, readState, reportSpans, run, scanSpans } from "./lib.mjs";
import { build, compactGraph, dedupe, writeGraph } from "./hypothesis-graph.mjs";
import { sourceEvidenceCandidates } from "./source-evidence.mjs";
import { buildSourceEvidencePrompt, parseSourceEvidenceReply } from "./source-evidence-prompt.mjs";
import { generateSummary, summaryEnv } from "./summary.mjs";

function logNote(sessionId, msg) {
  try {
    fs.appendFileSync(path.join(obsDir(), "graph-worker.log"), `${new Date().toISOString()} session=${sessionId} ${msg}\n`);
  } catch {
    /* 留不下就留不下 */
  }
}

export function graphDir(traceId) {
  return path.join(obsDir(), "graphs", traceId);
}

/**
 * 代码证据：正则粗筛 → 模型切分（source-evidence.mjs / source-evidence-prompt.mjs）。
 * **best-effort**：没配模型 env、或某一条判不出来，就少一条代码证据，图照出。
 * 复用 summaryEnv()——跟诊断总结同一把 key，不额外要配置。
 * 一条 trace 的候选平均 4.9K 字符（27 条历史 trace 实测），逐个 Agent 回参各发一次。
 */
async function collectSourceEvidence(spans, note) {
  const cands = sourceEvidenceCandidates(spans);
  if (!cands.length) return { sourceEvidence: {}, sourceVerdict: {}, tried: 0, got: 0 };
  const env = summaryEnv();
  if (!env) {
    note(`代码证据：${cands.length} 条候选，但没配模型 env（DBDOG_SUMMARY_LLM_* / ANTHROPIC_*），跳过`);
    return { sourceEvidence: {}, sourceVerdict: {}, tried: 0, got: 0 };
  }
  const sourceEvidence = {};
  const sourceVerdict = {};
  let got = 0;
  for (const c of cands) {
    const prompt = buildSourceEvidencePrompt(c);
    if (!prompt) continue;
    try {
      const reply = await generateSummary([{ role: "user", content: prompt }], { ...env, maxTokens: 1500 });
      const parsed = parseSourceEvidenceReply(reply?.text ?? reply);
      if (!parsed) continue;
      if (parsed.steps.length) {
        sourceEvidence[parsed.id] = [...(sourceEvidence[parsed.id] ?? []), ...parsed.steps];
        got += parsed.steps.length;
      }
      // 裁决取粗筛的正则结果（c.verdict），不取模型的——见 source-evidence.mjs 文件头
      if (c.verdict && !sourceVerdict[parsed.id]) sourceVerdict[parsed.id] = c.verdict;
    } catch (err) {
      note(`代码证据：span ${c.spanId} 判切分失败（${err?.message ?? err}）`);
    }
  }
  return { sourceEvidence, sourceVerdict, tried: cands.length, got };
}

/** root = kind=agent 且无 parent；多条取最后一版（dedupe 已按后写赢）。 */
function rootOf(spans, rootSpanId) {
  return spans.find((s) => s.span_id === rootSpanId) ?? spans.find((s) => s.kind === "agent" && !s.parent_id) ?? null;
}

run(async () => {
  const sessionId = process.argv[2];
  if (!sessionId) return;
  try {
    const state = readState(sessionId);
    if (!state?.trace_id) return;
    const mine = [];
    await scanSpans((span) => {
      if (span.trace_id === state.trace_id) mine.push(span);
    });
    const spans = dedupe(mine);
    if (!spans.length) return;
    const ev = await collectSourceEvidence(spans, (m) => logNote(sessionId, `trace=${state.trace_id} ${m}`));
    const opts = { sourceEvidence: ev.sourceEvidence, sourceVerdict: ev.sourceVerdict };
    const { summary: s } = writeGraph(spans, graphDir(state.trace_id), { trace: state.trace_id, session: sessionId }, opts);
    logNote(sessionId, `trace=${state.trace_id} 假设 ${s.hypotheses} 工具边 ${s.tool_edges} 代码证据边 ${s.source_edges}（候选 ${ev.tried} 条回参）未挂 ${s.unattached_tools} 源码假设 ${s.source_hypotheses}/无现场证据 ${s.source_without_evidence}`);

    // ② 紧凑图挂 root 重发（server 存 root 行的 graph 列）
    const root = rootOf(spans, state.root_span_id);
    if (!root) {
      logNote(sessionId, `trace=${state.trace_id} 没有 root span，图未推 server`);
      return;
    }
    const graph = compactGraph(build(spans, opts));
    const ok = await reportSpans([{ ...root, graph }]);
    logNote(sessionId, ok ? `trace=${state.trace_id} 已推 root+graph（${JSON.stringify(graph).length} B）` : `trace=${state.trace_id} root+graph 未送达（未配上报 env 或上报失败）`);
  } catch (err) {
    logNote(sessionId, `failed: ${err?.message ?? err}`);
  }
});
