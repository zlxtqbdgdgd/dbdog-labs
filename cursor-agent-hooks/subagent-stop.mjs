#!/usr/bin/env node
// subagentStop — flush pending spans for the sidechain; do not emit/replace root agent span.
import {
  readStdinJson,
  readState,
  writeState,
  sessionKey,
  reportSpans,
  run,
} from "./lib.mjs";

run(async () => {
  const input = await readStdinJson();
  const key = sessionKey(input);
  if (!key) return;

  let state = readState(key);
  // If this conversation key is the parent, look for nothing else; sidechain keys were
  // cloned under subagent_id. Prefer explicit sidechain state when present.
  if (!state?.trace_id || state.active === false) return;

  const pending = Array.isArray(state.pending_spans) ? state.pending_spans : [];
  if (pending.length) {
    const ok = await reportSpans(pending);
    state.pending_spans = ok ? [] : pending;
  }

  // Bubble unreported batch back to parent so mainline stop can retry.
  const parentId = state.parent_conversation_id;
  if (parentId && parentId !== key) {
    const parent = readState(parentId);
    if (parent?.trace_id && parent.active !== false && state.pending_spans?.length) {
      const merged = [
        ...(Array.isArray(parent.pending_spans) ? parent.pending_spans : []),
        ...state.pending_spans,
      ];
      parent.pending_spans = merged;
      writeState(parentId, parent);
      state.pending_spans = [];
    }
  }

  writeState(key, state);
});
