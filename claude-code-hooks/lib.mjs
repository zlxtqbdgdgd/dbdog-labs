// 共用工具：状态文件、spans 落盘、stdin 解析。零依赖（node 内建）。
// 纪律与 src/telemetry.ts 相同：hook 绝不打断会话——所有错误吞掉、exit 0。
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";

/** 状态/产物目录（主会话一个状态文件 + 每子代理一个 + 共享 spans.jsonl）。 */
export function obsDir() {
  return process.env.DBDOG_OBS_DIR?.trim() || path.join(os.homedir(), ".claude", "dbdog-obs");
}

/** agent_id 直接进文件名，先滤掉路径分隔符等（实测是 hex 串，属兜底）。 */
function safeAgentId(agentId) {
  return String(agentId).replace(/[^A-Za-z0-9_-]/g, "");
}

/**
 * 状态文件路径。带 agentId 时指向该子代理的独立状态。
 * 2026-08-09 拆分：并行子代理会同时触发 SubagentStop，共用一个状态文件必然
 * 读-改-写互相覆盖（实测两个子代理的 SubagentStop 间隔 692ms，而上报超时 3s，
 * 窗口必然重叠）。一子代理一文件 = 单写者，从根上没有竞态。
 */
export function statePath(sessionId, agentId) {
  const name = agentId ? `${sessionId}.${safeAgentId(agentId)}` : sessionId;
  return path.join(obsDir(), `${name}.json`);
}

/**
 * 确定性派生 span_id（16 hex）——与 root_span_id 从 trace_id 前 16 hex 派生同源。
 * 用途：子代理的 span 在 SubagentStop 时就要落盘，而父侧那次 Agent 调用的
 * tool_result（携带 agentId）此刻还没写进主 transcript，当场拿不到父 span_id。
 * 两侧各自用 (trace_id, agent_id) 算出同一个值，就不需要互相通信也能挂上父子。
 */
export function deriveSpanId(traceId, key) {
  return crypto.createHash("sha256").update(`${traceId}:${key}`).digest("hex").slice(0, 16);
}

/** spans 输出（Phase A 本地 JSONL；Phase C 起改 POST 上报，见 ADR-0008/课题 §5）。 */
export function spansPath() {
  return process.env.DBDOG_OBS_SPANS?.trim() || path.join(obsDir(), "spans.jsonl");
}

let hooksVersionCache;

/**
 * 本 kit 自己的版本——**从插件清单读，不在脚本里抄常量**（同一事实只许一个 owning path）。
 * 定位是确定性的：hooks.json 里每个 hook 都就地执行
 * `${CLAUDE_PLUGIN_ROOT}/claude-code-hooks/<x>.mjs`，install.mjs 也只改 settings.json 的
 * env 块、从不拷贝脚本，所以本文件永远与 `.claude-plugin/plugin.json` 保持同一层相对关系，
 * 不需要读 CLAUDE_PLUGIN_ROOT。读不到/无该字段一律 "unknown"——版本章只记不拦，
 * 缺章不得影响 span 落盘（hook 纪律：不抛、不打断会话）。模块级缓存一次。
 */
export function hooksVersion() {
  if (hooksVersionCache === undefined) {
    let v;
    try {
      const manifest = JSON.parse(
        fs.readFileSync(new URL("../.claude-plugin/plugin.json", import.meta.url), "utf8"),
      );
      v = typeof manifest.version === "string" ? manifest.version.trim() : "";
    } catch {
      v = "";
    }
    hooksVersionCache = v || "unknown";
  }
  return hooksVersionCache;
}

/**
 * root span 的 tags——Stop 与 SessionEnd 两个 root 合成点共用这一份。
 * `hooks_version` 是版本章（设计 D6「五个全自动，谁经手谁盖；只记不拦」）里 hook 那一格：
 * 一条 trace 得说得出自己跑在哪一版 hook 上，否则跨 run 对比时无从判断差异是不是版本引起的。
 */
export function rootSpanTags(state) {
  return {
    trace_source: "client",
    hooks_version: hooksVersion(),
    ...(state.ml_app ? { ml_app: state.ml_app } : {}),
  };
}

export function readState(sessionId, agentId) {
  try {
    return JSON.parse(fs.readFileSync(statePath(sessionId, agentId), "utf8"));
  } catch {
    return null;
  }
}

export function writeState(sessionId, state, agentId) {
  fs.mkdirSync(obsDir(), { recursive: true });
  fs.writeFileSync(statePath(sessionId, agentId), JSON.stringify(state));
}

export function appendSpans(spans) {
  if (!spans.length) return;
  fs.mkdirSync(path.dirname(spansPath()), { recursive: true });
  fs.appendFileSync(spansPath(), spans.map((s) => JSON.stringify(s)).join("\n") + "\n");
}

/**
 * 流式扫描本地 spans.jsonl（真相源）：逐行 JSON.parse 后回调 visit(span)，脏行跳过，
 * 文件不存在则一次都不回调。绝不整文件读进内存——实测 376MB 的 spans.jsonl 让
 * readFileSync+split 的旧实现常驻 2GB、跑 57s，再涨到 Node 字符串上限直接抛（hook 吞错，
 * 补发与总结静默失效）。调用方只保留自己要的那几条（sweep 按 pending id、worker 按 trace）。
 */
export async function scanSpans(visit) {
  let stream;
  try {
    stream = fs.createReadStream(spansPath(), { encoding: "utf8" });
  } catch {
    return;
  }
  try {
    const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });
    for await (const line of rl) {
      if (!line) continue;
      let span;
      try {
        span = JSON.parse(line);
      } catch {
        continue; // 容忍脏行
      }
      if (span?.span_id) visit(span);
    }
  } catch {
    /* 文件不存在 / 读到一半出错：按缺失处理，调用方拿到的是已扫到的部分 */
  } finally {
    stream.destroy();
  }
}

/** 按 span_id 捞回全文（同 id 多行取最后一行 = 后写赢），保持传入顺序；捞不到的丢弃。 */
export async function lookupSpans(ids) {
  if (!ids?.length) return [];
  const wanted = new Set(ids);
  const found = new Map();
  await scanSpans((span) => {
    if (wanted.has(span.span_id)) found.set(span.span_id, span);
  });
  return ids.map((id) => found.get(id)).filter(Boolean);
}

/** 兼容两种 pending 格式：新的字符串 id、旧的 span 全文对象。统一成 id 列表。 */
export function pendingIds(pending) {
  if (!Array.isArray(pending)) return [];
  return pending.map((x) => (typeof x === "string" ? x : x?.span_id)).filter(Boolean);
}

/**
 * 上报 dbdog（Phase C，课题 §5 信道①）：POST 到 mcp 边缘代理（或 server 直连），
 * DD-API-KEY 鉴权（server 侧 key→org 租户路由）。两个 env 齐备才发；短超时、
 * 吞错——本地 JSONL 永远先落（真相源），上报失败不丢数据、不打扰会话。
 *   DBDOG_OBS_REPORT_URL  填 dbdog-mcp 的边缘口：http://<mcp地址>/api/v2/llmobs/spans
 *                       （mcp 原样转发内网 dbdog-server；用户机器不直连 server。
 *                        server 直连仅限内网部署场景。）
 *   DBDOG_OBS_API_KEY     dbdog API key（控制台 settings/api-keys 签发）
 *   DBDOG_OBS_REPORT_TIMEOUT_MS  上报超时，见 reportTimeoutMs()
 */
export async function reportSpans(spans) {
  const url = process.env.DBDOG_OBS_REPORT_URL?.trim();
  const key = process.env.DBDOG_OBS_API_KEY?.trim();
  if (!url || !key || !spans.length) return false;
  try {
    const response = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json", "DD-API-KEY": key },
      // `*_local` 是纯本地全量字段（见 capField）：远端只收 contentCap 截断后的正文。
      body: JSON.stringify({ spans: spans.map(stripLocal) }),
      signal: AbortSignal.timeout(reportTimeoutMs()),
    });
    return response.ok;
  } catch {
    // best-effort：上报不可达不影响本地沉淀
    return false;
  }
}

/**
 * 上报超时（ms，默认 3000）。默认值按「本机直连 mcp」定：实测 ingest 服务端只花几毫秒，
 * 3s 绰绰有余。但客户端常挂在透明代理/隧道后（TUN 模式的机场客户端连 `--noproxy` 都截走），
 * 首字节被拉到 1–4s 抖动，正好骑在 3s 上——症状是 spans.jsonl 有、平台上没有，且
 * `pending_spans` 每轮累积、重发包越滚越大越发不可能成功。这种链路放宽到 10000–15000。
 * 根治仍是给 mcp 地址加代理直连规则；本值只是不依赖用户改代理的保底。
 */
export function reportTimeoutMs() {
  const n = Number(process.env.DBDOG_OBS_REPORT_TIMEOUT_MS ?? "");
  return Number.isFinite(n) && n > 0 ? n : 3000;
}

/** 内容截断上限（对齐 mcp 的 DBDOG_TELEMETRY_OUTPUT_CHARS 先例，默认 8000）。 */
export function contentCap() {
  const n = Number(process.env.DBDOG_OBS_CONTENT_CHARS ?? "");
  return Number.isFinite(n) && n > 0 ? n : 8000;
}

/**
 * 本地全量、上报截断（2026-09-08）：正文字段远端只收 contentCap 截断值；超限时本地多落一份
 * `<field>_local` 全量副本（未超限不落，读侧统一 `x_local ?? x`）。hook 只采原文不做语义
 * 解析——提取（假设「提出」事件等）在处理侧做，处理侧因此必须拿得到全文。
 */
export function capField(field, s) {
  if (typeof s !== "string") return { [field]: null };
  const c = contentCap();
  return s.length > c ? { [field]: s.slice(0, c), [`${field}_local`]: s } : { [field]: s };
}

/** 剥掉所有 `*_local` 字段——上报前调用，远端 schema 不变、带宽不浪费。 */
export function stripLocal(span) {
  return Object.fromEntries(Object.entries(span).filter(([k]) => !k.endsWith("_local")));
}

export function cap(s) {
  if (typeof s !== "string") return null;
  const c = contentCap();
  return s.length > c ? s.slice(0, c) : s;
}

export async function readStdinJson() {
  const chunks = [];
  for await (const c of process.stdin) chunks.push(c);
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

/** 顶层包装：出错只写 stderr、永远 exit 0（hook 不得打断会话）。 */
export function run(main) {
  main().catch((err) => {
    process.stderr.write(`[dbdog-obs hook] ${err?.stack ?? err}\n`);
    process.exit(0);
  });
}
