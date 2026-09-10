#!/usr/bin/env node
// afterAgentResponse — one llm span per assistant message; stash text for root output.
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
  state.last_assistant_text = text;

  const span = {
    trace_id: state.trace_id,
    span_id: newSpanId(),
    parent_id: state.root_span_id,
    session_id: state.session_id,
    kind: "llm",
    name: "cursor.assistant",
    model: input.model ?? input.model_id ?? null,
    status: "ok",
    ts: new Date().toISOString(),
    duration_ms: null,
    input: null,
    output: cap(text),
    tokens_input: null,
    tokens_output: null,
    tokens_cache_read: null,
    tokens_cache_creation: null,
    tags: {
      sidechain: state.sidechain === "1" ? "1" : "0",
      ...(state.ml_app ? { ml_app: state.ml_app } : {}),
      client: "cursor",
    },
  };

  await emitSpans(state, key, [span]);
});
