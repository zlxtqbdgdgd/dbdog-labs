#!/usr/bin/env node
// stop — emit/refresh root agent span for the mainline conversation.
import {
  readStdinJson,
  readActiveState,
  cap,
  emitSpans,
  run,
} from "./lib.mjs";

run(async () => {
  const input = await readStdinJson();
  const { key, state } = readActiveState(input);
  if (!key || !state) return;

  // Subagent loops must not overwrite the mainline root (handled by subagent-stop).
  if (state.sidechain === "1") return;

  const status = input.status === "error" ? "error" : "ok";
  const output =
    typeof input.last_assistant_message === "string" && input.last_assistant_message
      ? input.last_assistant_message
      : state.last_assistant_text || "";

  const span = {
    trace_id: state.trace_id,
    span_id: state.root_span_id,
    parent_id: null,
    session_id: state.session_id,
    kind: "agent",
    name: "cursor-agent.task",
    model: null,
    status,
    ts: state.started_at,
    duration_ms: state.started_at ? Date.now() - Date.parse(state.started_at) : null,
    input: cap(state.prompt ?? ""),
    output: cap(output),
    tokens_input: null,
    tokens_output: null,
    tokens_cache_read: null,
    tokens_cache_creation: null,
    tags: {
      trace_source: "client",
      client: "cursor",
      ...(state.ml_app ? { ml_app: state.ml_app } : {}),
      ...(input.status ? { stop_status: String(input.status) } : {}),
    },
  };

  await emitSpans(state, key, [span], { isRootStop: true });
});
