#!/usr/bin/env node
// probe.mjs — 反向证据链的探针（飞轮 D2 / 设计 §7.5）。
//
// 读一例判题包目录里的 `reverse.json`，把每条「用 dbdog 取」的证据在**那次诊断的时间窗**上真查一遍。
// 探针的价值只有一句话：**同样的工具、同样的参数，由固定代码发出，不受大模型干扰**——
// 脚本能拿到而模型没拿到 = 模型的问题；脚本也拿不到 = dbdog 的问题。判题模型据此把
// 「没想到查」与「查了也没有」分开，这在 trace 里本来长得一模一样。
//
//   腿一（**唯一的产品腿**）：经 mcp 调工具。默认走本仓的**内存态直调**（`dist/server.js` +
//         InMemoryTransport，与 scripts/call-tool.mjs 同一条路：完整 mcp 管线，不需要起服务、不碰 e2e）；
//         `--mcp-http` 改走 HTTP MCP（initialize → tools/call，凭证读 env DBDOG_MCP_URL / DBDOG_MCP_BEARER）。
//         走 mcp 而不是绕到存储层，是因为探针四值里的「工具没注册 / 无权限」两档**只有 mcp 这一层答得出**
//         ——那问的是「用户能不能调到」，不是「库里有没有」（D9 的需求信号正来自这里）。
//   腿二（**内部归因用，默认不跑**）：证据带 `direct_query` 时打 server 直查口
//         `POST /api/v2/llmobs/probe/query`（仅内部 bearer；单条 SELECT/WITH）。要 `--with-direct` 显式开。
//
// ## 为什么腿二不在产品路径上（2026-09-11 owner 拍板）
// 原设计说「两腿不一致 = dbdog 撒谎的唯一硬证据」。回头核 §8#6 那个真 bug（wait_event 过滤
// 返 0）的发现过程，原文是「**两次独立判题都从 trace 抓到这对矛盾**」——发现它的是判题模型
// 读同一条 trace 里的自相矛盾（不加过滤 16 条、加了过滤 0 条），跟腿二无关；直查 CH 拿到的
// 那 181 条空串对，是我们**修 bug 时做归因**用的。发现与归因是两件事，只有后者要直查存储。
// 而直查口连的是 ctl 库、能列出所有 CH 库，租户隔离靠的是默认库而不是权限，本来就不该对外。
// 于是塌缩：产品路径只留腿一，普通用户拿自己的 API key 连 mcp 就能跑；腿二留给我们归因。
//
// 用法：
//   npm run build   # 内存态直调要 dist/
//   node scripts/llmobs/probe.mjs --case <包里的 cases/<event_id> 目录> [--mcp-http] [--with-direct] [--server-direct]
//
//   --mcp-http       腿一改走 HTTP MCP（跨机、或想量「真实客户端看到的目录」时用）
//   --with-direct    额外跑腿二（需要 DBDOG_INTERNAL_TOKEN；归因时用）
//   --server-direct  只跑腿二（不起 mcp，dist/ 没建时也能用），隐含 --with-direct
//
// env：DBDOG_BASE_URL + DBDOG_API_KEY（或 DBDOG_INTERNAL_TOKEN）；DBDOG_ORG（仅内部凭证面）；
//      DBDOG_MCP_URL / DBDOG_MCP_BEARER（仅 --mcp-http）；腿二额外要 DBDOG_INTERNAL_TOKEN。
import fs from "node:fs";
import path from "node:path";
import { callStatus, hasInternalToken, requireCredential } from "./lib/exp-client.mjs";
import { dbdogEvidence, probeOne, summarize, windowOfTrace } from "./lib/probe.mjs";

const argOf = (name, dflt) => {
  const i = process.argv.indexOf(name);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : dflt;
};
const has = (name) => process.argv.includes(name);
const fail = (m) => { console.error(`✗ ${m}`); process.exit(1); };

const CASE = argOf("--case", "");
const SERVER_DIRECT_ONLY = has("--server-direct");
const MCP_HTTP = has("--mcp-http");
// 腿二默认关。`--server-direct` 是它的极端形态（只跑腿二），自然隐含开。
const WITH_DIRECT = SERVER_DIRECT_ONLY || has("--with-direct");
if (!CASE) fail("--case 必填（判题包里的 cases/<event_id> 目录）");
requireCredential();
// 直查口在 handler 里硬验内部 bearer（server `llmobs_probe_query.go` 的闸一），拿 API key 去打只会 401。
// 判据是**有没有**内部凭证，不是「当前生效的是不是它」——装了 hooks 的人环境里永远有
// DBDOG_OBS_API_KEY，按生效凭证判的话，两个都配齐了照样会被拒。
if (WITH_DIRECT && !hasInternalToken()) {
  fail("腿二（--with-direct / --server-direct）只认 DBDOG_INTERNAL_TOKEN——它是内部归因工具，不在产品路径上");
}

const readJson = (rel) => {
  const p = path.join(CASE, rel);
  return fs.existsSync(p) ? JSON.parse(fs.readFileSync(p, "utf8")) : null;
};

const chain = readJson("reverse.json");
if (!chain) fail(`${path.join(CASE, "reverse.json")} 不存在——这一例没有反向证据链，探针无从探起`);
const trace = readJson("trace.json");
const window = windowOfTrace(trace);
const evidences = dbdogEvidence(chain);
if (!evidences.length) fail("反向链里没有一条 source=dbdog 的证据");

// ── 腿一：mcp ────────────────────────────────────────────────────────────────
async function inMemoryLeg() {
  const dist = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..", "..", "dist");
  if (!fs.existsSync(path.join(dist, "server.js"))) {
    fail("dist/ 不在（先 npm run build），或用 --mcp-http / --server-direct");
  }
  const { buildServer } = await import(`${dist}/server.js`);
  const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
  const { InMemoryTransport } = await import("@modelcontextprotocol/sdk/inMemory.js");
  const { ensureEngineRegistry } = await import(`${dist}/toolsets/dbm/shared/database-engine.js`);
  const { createDbDogClient } = await import(`${dist}/client/dbdogClient.js`);
  // 含 dbm 的会话建立前必须先从 server 拉引擎注册表（与线上 openSession 同一条路）。
  await ensureEngineRegistry(createDbDogClient());
  const server = buildServer(undefined, { tools: "all", toolsets: "all", skillsets: "all", databases: "all" });
  const [ct, st] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "llmobs-probe", version: "0.0.0" });
  await Promise.all([server.connect(st), client.connect(ct)]);
  const knownTools = new Set((await client.listTools()).tools.map((t) => t.name));
  return {
    knownTools,
    callTool: async (name, args) => {
      try {
        const res = await client.callTool({ name, arguments: withIntent(args) });
        return { isError: Boolean(res.isError), text: (res.content ?? []).map((c) => c.text ?? "").join("\n") };
      } catch (e) {
        return { error: e.message || String(e) };
      }
    },
    close: () => client.close(),
  };
}

/** 每次工具调用强制带 telemetry.intent（硬约束 9）——探针也不例外，它同样是需求信号。 */
function withIntent(args) {
  if (args?.telemetry?.intent) return args;
  return { ...args, telemetry: { ...(args?.telemetry ?? {}), intent: "reverse-evidence probe: re-run this evidence on the diagnosis window" } };
}

/** HTTP MCP（Streamable HTTP）：initialize → initialized → tools/list → tools/call。 */
async function httpLeg() {
  const url = (process.env.DBDOG_MCP_URL || "").trim();
  const bearer = (process.env.DBDOG_MCP_BEARER || "").trim();
  if (!url) fail("--mcp-http 需要 env DBDOG_MCP_URL");
  let sessionId = "";
  let id = 0;
  const rpc = async (method, params) => {
    const res = await fetch(url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        ...(bearer ? { authorization: `Bearer ${bearer}` } : {}),
        ...(sessionId ? { "mcp-session-id": sessionId } : {}),
      },
      body: JSON.stringify({ jsonrpc: "2.0", ...(method.startsWith("notifications/") ? {} : { id: ++id }), method, params }),
      signal: AbortSignal.timeout(60_000),
    });
    const sid = res.headers.get("mcp-session-id");
    if (sid) sessionId = sid;
    const text = await res.text();
    if (!res.ok) throw new Error(`HTTP ${res.status} ${method}: ${text.slice(0, 200)}`);
    if (!text.trim()) return null;
    // SSE 帧（`event: message` + `data: {...}`）与裸 JSON 两种都收。
    const payload = text.includes("data:")
      ? text.split("\n").filter((l) => l.startsWith("data:")).map((l) => l.slice(5).trim()).join("")
      : text;
    const body = JSON.parse(payload);
    if (body.error) throw new Error(`${method}: ${body.error.message ?? JSON.stringify(body.error)}`);
    return body.result;
  };
  await rpc("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "llmobs-probe", version: "0.0.0" } });
  await rpc("notifications/initialized", {});
  const list = await rpc("tools/list", {});
  return {
    knownTools: new Set((list?.tools ?? []).map((t) => t.name)),
    callTool: async (name, args) => {
      try {
        const res = await rpc("tools/call", { name, arguments: withIntent(args) });
        return { isError: Boolean(res?.isError), text: (res?.content ?? []).map((c) => c.text ?? "").join("\n") };
      } catch (e) {
        return { error: e.message || String(e) };
      }
    },
    close: async () => {},
  };
}

// ── 腿二：server 直查口 ──────────────────────────────────────────────────────
async function directQuery(spec) {
  const res = await callStatus("POST", "/api/v2/llmobs/probe/query", spec, { internalOnly: true });
  if (res.status === 404 || res.status === 405) {
    return { status: "unavailable", detail: `直查口还没上线（HTTP ${res.status} POST /api/v2/llmobs/probe/query）——腿二本轮全缺` };
  }
  if (res.status === 401 || res.status === 403) {
    return { status: "unavailable", detail: `直查口拒绝凭证（HTTP ${res.status}）：它只认内部 bearer` };
  }
  if (!res.ok) return { status: "error", detail: `HTTP ${res.status}: ${res.text.slice(0, 200)}` };
  const rows = Array.isArray(res.json?.rows) ? res.json.rows : [];
  return { status: "ok", rows: rows.length, preview: JSON.stringify(rows.slice(0, 3)).slice(0, 600) };
}

// ── 跑 ────────────────────────────────────────────────────────────────────────
const leg1 = SERVER_DIRECT_ONLY ? { knownTools: new Set(), callTool: null, close: async () => {} } : (MCP_HTTP ? await httpLeg() : await inMemoryLeg());
const results = [];
for (const evidence of evidences) {
  const row = await probeOne(evidence, {
    knownTools: leg1.knownTools,
    callTool: leg1.callTool ?? (async () => ({ error: "本次只跑腿二（--server-direct）" })),
    directQuery: WITH_DIRECT ? directQuery : null,
    window,
  });
  if (SERVER_DIRECT_ONLY && row.tool_leg?.outcome) {
    row.tool_leg = { probed: false, skip_reason: "--server-direct：本次不跑 mcp 腿" };
    row.consistency = "not_probed";
  }
  results.push(row);
  console.error(`· ${row.id} ${row.tool ?? "（无工具）"} → ${row.tool_leg?.outcome ?? "未探"} / ${row.consistency}`);
}
await leg1.close();

const probe = {
  generated_at: new Date().toISOString(),
  case: path.basename(path.resolve(CASE)),
  window,
  legs: {
    tool: SERVER_DIRECT_ONLY ? "skipped" : (MCP_HTTP ? "mcp-http" : "mcp-in-memory"),
    direct: !WITH_DIRECT
      ? "off（产品路径只跑腿一；归因时加 --with-direct）"
      : (results.some((r) => r.direct_leg?.status === "ok")
        ? "server-direct-query"
        : (results.find((r) => r.direct_leg?.status === "unavailable")?.direct_leg?.detail ?? "skipped")),
  },
  summary: summarize(results),
  evidence: results,
};
fs.writeFileSync(path.join(CASE, "probe.json"), JSON.stringify(probe, null, 1));

const s = probe.summary;
console.error("");
console.error(`✓ probe.json → ${path.join(path.resolve(CASE), "probe.json")}`);
console.error(`  腿一：符合 ${s.obtained_match} · 不符 ${s.obtained_mismatch} · 空/报错 ${s.empty_or_error} · 无工具 ${s.no_tool} · 未探 ${s.not_probed}`);
if (WITH_DIRECT) {
  console.error(`  两腿：一致 ${s.consistent} · 疑似工具 bug ${s.tool_bug_suspect} · 都没有 ${s.data_absent} · 没跑腿二 ${s.total - s.consistent - s.tool_bug_suspect - s.data_absent}`);
  if (s.tool_bug_suspect > 0) console.error("  ⚠ 有两腿不一致的证据——判题时「工具错」这一类改进点的硬证据就在这里");
}
