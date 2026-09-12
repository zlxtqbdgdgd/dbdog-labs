#!/usr/bin/env node
// backfill-graphs.mjs — 历史 trace 回刷：重跑代码证据两段 → 重建图 → root 带新图重推 server。
//
// 为什么要回刷：代码证据（source-evidence 两段）是 2026-09-12 才加的，此前跑完的 trace
// 图里没有这一类边。原始 span 都还在本地 spans.jsonl 里，重算一遍即可——不用等新 trace。
// 推的是 root span 同键重插（Replacing 后写赢，与判题投影 evaluation.* 同一机制）。
//
// 用法：node backfill-graphs.mjs <spans.jsonl 或含它的目录>... [--dry-run] [--trace <前缀>] [--all]
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
import { remoteReason, rootForBackfill, serverTagDiff } from "./backfill-root.mjs";

/**
 * 从服务端拉这条 trace 的 root span —— 它是重推的**唯一**合法载体。
 * 走 `GET /trace/{id}`（整条 trace）而不是 `spans/search`：后者的回参投影里**没有
 * model / intent**，照抄推回去会把这两列抹空（与 tag 那个坑同族）。
 */
async function remoteRoot(traceId) {
  const base = (process.env.DBDOG_BASE_URL ?? "").replace(/\/+$/, "");
  const key = process.env.DBDOG_API_KEY ?? process.env.DBDOG_OBS_API_KEY ?? "";
  if (!base || !key) return { root: null, reason: "unreachable" };
  const res = await fetch(`${base}/api/v2/llmobs/trace/${encodeURIComponent(traceId)}`, {
    headers: { "DD-API-KEY": key },
  }).catch(() => null);
  // 404 = 服务端确实没有这条，跳过是对的；连不上 / 5xx = **取不到**，跟「没有」是两回事。
  // 这个判断如今当前置过滤器用，服务端抖一下就会让那段时间的 trace 全被静默丢掉，所以必须分开。
  // （2026-09-12 02:25–02:27 dbdog-server 刚重启过一次，18080 有 100 秒 HTTP 000。）
  const reason = remoteReason(res);
  if (reason !== "ok") return { root: null, reason };
  const body = await res.json().catch(() => null);
  const root = (body?.spans ?? []).find((s) => s.kind === "agent" && !s.parent_id) ?? null;
  return { root, reason: root ? "ok" : "absent" };
}

/** 开跑前探活：连不上就别开跑，比跑到一半才发现强。 */
async function serverAlive() {
  const base = (process.env.DBDOG_BASE_URL ?? "").replace(/\/+$/, "");
  const key = process.env.DBDOG_API_KEY ?? process.env.DBDOG_OBS_API_KEY ?? "";
  if (!base || !key) return false;
  const res = await fetch(`${base}/api/v2/llm-obs/v1/projects`, { headers: { "DD-API-KEY": key } }).catch(() => null);
  return Boolean(res?.ok);
}

const args = process.argv.slice(2);
const DRY = args.includes("--dry-run");
const ALL = args.includes("--all"); // 连没有 dbdog 调用的会话也回刷
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
if (!process.env.DBDOG_BASE_URL || !(process.env.DBDOG_API_KEY ?? process.env.DBDOG_OBS_API_KEY)) {
  // 没有这两个就一条都推不了（root 只能来自服务端）。早说，别让人跑完几小时模型才发现。
  console.error("⚠ 没配 DBDOG_BASE_URL / DBDOG_API_KEY——服务端 root 一条都拉不到，本次不会推任何东西");
}
if (!(await serverAlive())) {
  console.error("✗ 服务端探活不过（GET /api/v2/llm-obs/v1/projects 不是 200）——不开跑，先把 DBDOG_BASE_URL / 隧道 / 服务本身确认好");
  process.exit(2);
}
console.error(`共 ${byTrace.size} 条 trace${DRY ? "（dry-run，不推）" : ""}`);

let pushed = 0, failed = 0, edges = 0, withEv = 0, skippedRemote = 0, skippedNotDiag = 0, unreachable = 0;
for (const [trace, raw] of byTrace) {
  const spans = dedupe(raw);
  const root = spans.find((s) => s.kind === "agent" && !s.parent_id);
  if (!root) { console.error(`  ${trace.slice(0, 10)} 没有 root span，跳过`); continue; }
  // 没有一次 dbdog 调用的 trace 不回刷：那是日常编码会话，不是诊断——图上零工具边，
  // 推上去只给控制台添噪声（仓里的口径本来就是「假设树只算 dbdog 调用」）。这道闸放在
  // 服务端 GET 之前，因为它是本地判断、不花钱：本机 217 条里绝大多数在这里就筛掉了。
  // tags.mcp_server 存的是 MCP 的**注册名**（synthesize.mjs 从 `mcp__<server>__<tool>` 里截的），
  // 本机注册成 `dbdog`、别的机器可能是 `dbdog-mcp`——按前缀认，别钉死某一个值。
  const dbdogCalls = spans.filter((x) => x.kind === "tool" && String(x.tags?.mcp_server ?? "").startsWith("dbdog")).length;
  if (!dbdogCalls && !ALL) { skippedNotDiag += 1; continue; }

  // **先拉服务端 root，再跑模型**：服务端没有这条 trace 就根本推不上去，先花几分钟模型钱
  // 再发现「拉不到」纯属浪费（2026-09-12 实测：本机 217 条 trace 里绝大多数是日常编码会话，
  // 压根不在服务端）。dry-run 也照拉——一个 GET 而已，还能顺带告诉你哪些回刷得上。
  const { root: rr, reason } = await remoteRoot(trace);
  if (!rr) {
    if (reason === "absent") {
      skippedRemote += 1;
      console.error(`  ${trace.slice(0, 10)} 服务端没有这条 trace 的 root——跳过（不用本地版顶替）`);
    } else {
      unreachable += 1;
      console.error(`  ${trace.slice(0, 10)} ⚠ 服务端取不到（不是「没有」）——跳过，这条要重跑`);
    }
    continue;
  }
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
  const outgoing = rootForBackfill(rr, graph);
  if (!outgoing) {
    failed += 1;
    console.error(`  ${trace.slice(0, 10)} 服务端那份 root 不成形——跳过，不用本地版顶替`);
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
console.error(`\n合计：${byTrace.size} 条 · 非诊断会话 ${skippedNotDiag} 条 · 服务端没有 ${skippedRemote} 条 · 有代码证据 ${withEv} 条 · 代码证据边 ${edges} · 已推 ${pushed} · 失败 ${failed}`);
if (unreachable) console.error(`⚠ 另有 ${unreachable} 条是**服务端取不到**（网络/5xx），不是「不在服务端」——重跑这批，别当成已处理`);
