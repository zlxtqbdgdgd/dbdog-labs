// Shared helpers for Cursor Agent Observability hooks.
// Same discipline as claude-code-hooks: never break the session — swallow errors, exit 0.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";

/** State + spans live under ~/.cursor/dbdog-obs by default (separate from Claude). */
export function obsDir() {
  return process.env.DBDOG_OBS_DIR?.trim() || path.join(os.homedir(), ".cursor", "dbdog-obs");
}

export function statePath(sessionId) {
  return path.join(obsDir(), `${sessionId}.json`);
}

export function spansPath() {
  return process.env.DBDOG_OBS_SPANS?.trim() || path.join(obsDir(), "spans.jsonl");
}

export function readState(sessionId) {
  if (!sessionId) return null;
  try {
    return JSON.parse(fs.readFileSync(statePath(sessionId), "utf8"));
  } catch {
    return null;
  }
}

export function writeState(sessionId, state) {
  fs.mkdirSync(obsDir(), { recursive: true });
  fs.writeFileSync(statePath(sessionId), JSON.stringify(state));
}

/** Resolve session key from Cursor payloads (conversation_id) or Claude-compat (session_id). */
export function sessionKey(input) {
  return input?.conversation_id || input?.session_id || null;
}

/** Active trace state for this hook input; prefers conversation_id then session_id. */
export function readActiveState(input) {
  const key = sessionKey(input);
  const state = readState(key);
  if (state?.trace_id && state.active !== false) return { key, state };
  return { key, state: null };
}

export function appendSpans(spans) {
  if (!spans.length) return;
  fs.mkdirSync(path.dirname(spansPath()), { recursive: true });
  fs.appendFileSync(spansPath(), spans.map((s) => JSON.stringify(s)).join("\n") + "\n");
}

export async function reportSpans(spans) {
  const url = process.env.DBDOG_OBS_REPORT_URL?.trim();
  const key = process.env.DBDOG_OBS_API_KEY?.trim();
  if (!url || !key || !spans.length) return false;
  try {
    const response = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json", "DD-API-KEY": key },
      body: JSON.stringify({ spans }),
      signal: AbortSignal.timeout(3000),
    });
    return response.ok;
  } catch {
    return false;
  }
}

export function contentCap() {
  const n = Number(process.env.DBDOG_OBS_CONTENT_CHARS ?? "");
  return Number.isFinite(n) && n > 0 ? n : 8000;
}

export function cap(s) {
  if (typeof s !== "string") return null;
  const c = contentCap();
  return s.length > c ? s.slice(0, c) : s;
}

export function newSpanId() {
  return crypto.randomBytes(8).toString("hex");
}

export async function readStdinJson() {
  const chunks = [];
  for await (const c of process.stdin) chunks.push(c);
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

/** Best-effort debug trail (never throws). Override path with DBDOG_OBS_DEBUG_LOG. */
export function debugLog(event, fields = {}) {
  try {
    const p =
      process.env.DBDOG_OBS_DEBUG_LOG?.trim() ||
      path.join(os.homedir(), ".cursor", "dbdog-obs", "_hook-debug.jsonl");
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.appendFileSync(
      p,
      JSON.stringify({ ts: new Date().toISOString(), event, ...fields }) + "\n",
    );
  } catch {
    /* ignore */
  }
}

export function run(main) {
  main().catch((err) => {
    process.stderr.write(`[dbdog-obs cursor-hook] ${err?.stack ?? err}\n`);
    debugLog("hook_error", { error: String(err?.stack ?? err) });
    // Prefer continue:true so beforeSubmitPrompt never looks like empty-stdout failure.
    try {
      if (!process.stdout.writableEnded) {
        process.stdout.write(JSON.stringify({ continue: true }) + "\n");
      }
    } catch {
      /* ignore */
    }
    process.exit(0);
  });
}

/** Normalize full-width colon so 「诊断：」 matches 「诊断:」. */
export function normColon(s) {
  return String(s ?? "").replace(/：/g, ":");
}

/**
 * Prompt text for the trigger gate.
 * Prefer raw `prompt`; if Cursor wraps with <user_query>, unwrap that body.
 */
export function promptForTrigger(input) {
  const raw = typeof input?.prompt === "string" ? input.prompt : "";
  const m = /<user_query>\s*([\s\S]*?)\s*<\/user_query>/i.exec(raw);
  return (m ? m[1] : raw).trimStart();
}

/** Trigger gate — same semantics as Claude kit. */
export function isTriggered(promptText) {
  const mode = (process.env.DBDOG_OBS_MODE?.trim() || "triggered").toLowerCase();
  if (mode === "off") return false;
  if (mode === "always") return true;
  const trigger = process.env.DBDOG_OBS_TRIGGER?.trim() || "诊断:";
  const text = normColon(String(promptText ?? "").trimStart());
  return text.startsWith(normColon(trigger)) || text.toLowerCase().startsWith("diag:");
}

/**
 * Cursor: MCP:<tool_name>  |  Claude: mcp__server__tool
 * afterMCPExecution may pass bare tool name.
 */
export function parseMcpToolName(raw) {
  const name = String(raw ?? "");
  const cursor = /^MCP:(.+)$/i.exec(name);
  if (cursor) {
    const rest = cursor[1];
    // Optional server prefix forms we may see: "dbdog/get_x" or "dbdog:get_x"
    const split = /^([^/:]+)[/:](.+)$/.exec(rest);
    if (split && /dbdog/i.test(split[1])) {
      return { toolName: split[2], server: split[1], raw: name, isMcp: true };
    }
    return { toolName: rest, server: null, raw: name, isMcp: true };
  }
  const claude = /^mcp__(.+?)__(.+)$/.exec(name);
  if (claude) {
    return { toolName: claude[2], server: claude[1], raw: name, isMcp: true };
  }
  return { toolName: name, server: null, raw: name, isMcp: name.startsWith("MCP:") || name.startsWith("mcp__") };
}

/** Only inject/record for dbdog MCP tools (not datadog / other servers). */
export function isDbdogMcpTool(raw) {
  const parsed = parseMcpToolName(raw);
  if (/dbdog/i.test(parsed.raw)) return true;
  if (parsed.server && /dbdog/i.test(parsed.server)) return true;
  // Bare Cursor MCP tool names often include dbdog_ in the tool id itself
  if (parsed.isMcp && /dbdog/i.test(parsed.toolName)) return true;
  return false;
}

export function parseToolInput(toolInput) {
  if (toolInput && typeof toolInput === "object") return toolInput;
  if (typeof toolInput === "string" && toolInput.trim()) {
    try {
      const v = JSON.parse(toolInput);
      if (v && typeof v === "object") return v;
    } catch {
      /* keep empty */
    }
  }
  return {};
}

/** Split telemetry from tool args; return { args, intent, telemetry }. */
export function splitTelemetry(toolInput) {
  const obj = parseToolInput(toolInput);
  const telemetry = obj.telemetry && typeof obj.telemetry === "object" ? { ...obj.telemetry } : {};
  const { telemetry: _drop, ...args } = obj;
  const intent = typeof telemetry.intent === "string" ? telemetry.intent : "";
  return { args, intent, telemetry };
}

export function mlAppFrom(input) {
  if (process.env.DBDOG_OBS_ML_APP?.trim()) return process.env.DBDOG_OBS_ML_APP.trim();
  const roots = input?.workspace_roots;
  if (Array.isArray(roots) && roots[0]) return path.basename(roots[0]) || "unknown";
  if (input?.cwd) return path.basename(input.cwd) || "unknown";
  return path.basename(process.cwd()) || "unknown";
}

/** Persist + best-effort report; keep failed batch on state.pending_spans. */
export async function emitSpans(state, sessionId, spans, { isRootStop = false } = {}) {
  if (!state?.trace_id || state.active === false) return state;
  const pending = Array.isArray(state.pending_spans) ? state.pending_spans : [];
  appendSpans(spans);
  const batch = [...pending, ...spans];
  const ok = await reportSpans(batch);
  state.pending_spans = ok ? [] : batch;
  if (isRootStop) state.root_emitted = true;
  writeState(sessionId, state);
  return state;
}
