#!/usr/bin/env node
// graph-worker.mjs — SessionEnd 之后自动出假设图的 detached worker（2026-09-10，owner 定：
// 「hook 把 span-graph 的能力带上」——装了插件就有图，不用再手动跑 skill）。
// 由 session-end.mjs 在本 trace 收尾之后 spawn({detached:true}).unref() 起本进程：
// 读本 trace 的 span（流式，只留本 trace）→ hypothesis-graph.mjs 出图 →
// 写到 <obsDir>/graphs/<trace_id>/forward-path.{md,json} + forward-conclusion.md。
// 重入幂等：同 trace 覆盖同一目录。best-effort：任何失败只在 graph-worker.log 留一行。
// 用法：node graph-worker.mjs <sessionId>
import fs from "node:fs";
import path from "node:path";
import { obsDir, readState, run, scanSpans } from "./lib.mjs";
import { dedupe, writeGraph } from "./hypothesis-graph.mjs";

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
    const { summary: s } = writeGraph(spans, graphDir(state.trace_id), { trace: state.trace_id, session: sessionId });
    logNote(sessionId, `trace=${state.trace_id} 假设 ${s.hypotheses} 工具边 ${s.tool_edges} 未挂 ${s.unattached_tools} 源码假设 ${s.source_hypotheses}/无现场证据 ${s.source_without_evidence}`);
  } catch (err) {
    logNote(sessionId, `failed: ${err?.message ?? err}`);
  }
});
