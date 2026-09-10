#!/usr/bin/env node
// postToolUseFailure — tool span for failed/denied/timeout MCP calls (success path uses afterMCPExecution).
import {
  readStdinJson,
  readActiveState,
  isDbdogMcpTool,
  parseMcpToolName,
  splitTelemetry,
  cap,
  newSpanId,
  emitSpans,
  run,
} from "./lib.mjs";
import { hypothesisTags } from "./hypothesis.mjs";

run(async () => {
  const input = await readStdinJson();
  if (!isDbdogMcpTool(input.tool_name)) return;

  const { key, state } = readActiveState(input);
  if (!key || !state) return;

  const parsed = parseMcpToolName(input.tool_name);
  const { args, intent } = splitTelemetry(input.tool_input);

  let inputJson = null;
  try {
    inputJson = cap(JSON.stringify(args));
  } catch {
    /* leave null */
  }

  const duration =
    typeof input.duration === "number" && Number.isFinite(input.duration) ? input.duration : null;
  const err =
    typeof input.error_message === "string"
      ? input.error_message
      : input.failure_type
        ? String(input.failure_type)
        : "tool failure";

  const span = {
    trace_id: state.trace_id,
    span_id: newSpanId(),
    parent_id: state.root_span_id,
    session_id: state.session_id,
    kind: "tool",
    name: parsed.toolName || "unknown",
    model: null,
    status: "error",
    ts: new Date().toISOString(),
    duration_ms: duration,
    input: inputJson,
    output: cap(err),
    intent: intent || undefined,
    tokens_input: null,
    tokens_output: null,
    tokens_cache_read: null,
    tokens_cache_creation: null,
    tags: {
      sidechain: state.sidechain === "1" ? "1" : "0",
      ...(state.ml_app ? { ml_app: state.ml_app } : {}),
      ...(parsed.server ? { mcp_server: parsed.server } : { mcp_server: "dbdog" }),
      client: "cursor",
      ...hypothesisTags(intent),
      ...(input.failure_type ? { failure_type: String(input.failure_type) } : {}),
    },
  };

  await emitSpans(state, key, [span]);
});
