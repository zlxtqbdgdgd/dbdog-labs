#!/usr/bin/env node
// graph.mjs — 假设图命令行入口（span-graph skill 与人手都用它）。
//   node graph.mjs <spans.jsonl | 导出 JSON | 含 spans.jsonl 的目录> [--out 目录] [--trace id] [--session id]
// 产物写 forward-path.md / forward-path.json / forward-conclusion.md；实现单源在 hypothesis-graph.mjs。
import { run } from "./hypothesis-graph.mjs";

function parseArgs(argv) {
  const opts = {};
  const rest = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--out" || a === "--trace" || a === "--session") opts[a.slice(2)] = argv[++i];
    else rest.push(a);
  }
  return { input: rest[0], opts };
}

const { input, opts } = parseArgs(process.argv.slice(2));
if (!input) {
  process.stderr.write("用法: node graph.mjs <spans.jsonl|目录> [--out 目录] [--trace id] [--session id]\n");
  process.exit(2);
}
try {
  const { md, summary: s } = run(input, opts);
  process.stderr.write(
    `forward-path: 假设 ${s.hypotheses} · 假设边 ${s.parent_edges} · 工具边 ${s.tool_edges} · 收口 ${s.resolve_edges} · 未挂 ${s.unattached_tools}` +
      (s.source_hypotheses ? ` · 源码假设 ${s.source_hypotheses}（无现场证据 ${s.source_without_evidence}）` : "") +
      ` → ${md}\n`,
  );
} catch (err) {
  process.stderr.write(`${err?.message ?? err}\n`);
  process.exit(1);
}
