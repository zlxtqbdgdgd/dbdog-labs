#!/usr/bin/env node
// afterAgentThought — llm span for thinking blocks (tagged thought=1).
import {
  readStdinJson,
  readActiveState,
  cap,
  newSpanId,
  emitSpans,
  run,
} from "./lib.mjs";

run(async () => {
  const input = await readStdinJson();
  const { key, state } = readActiveState(input);
  if (!key || !state) return;

  const text = typeof input.text === "string" ? input.text : "";
  const duration =
    typeof input.duration_ms === "number" && Number.isFinite(input.duration_ms)
      ? input.duration_ms
      : null;

  const span = {
    trace_id: state.trace_id,
    span_id: newSpanId(),
    parent_id: state.root_span_id,
    session_id: state.session_id,
    kind: "llm",
    name: "cursor.thought",
    model: input.model ?? input.model_id ?? null,
    status: "ok",
    ts: new Date().toISOString(),
    duration_ms: duration,
    input: null,
    output: cap(text),
    tokens_input: null,
    tokens_output: null,
    tokens_cache_read: null,
    tokens_cache_creation: null,
    tags: {
      thought: "1",
      sidechain: state.sidechain === "1" ? "1" : "0",
      ...(state.ml_app ? { ml_app: state.ml_app } : {}),
      client: "cursor",
    },
  };

  await emitSpans(state, key, [span]);
});
