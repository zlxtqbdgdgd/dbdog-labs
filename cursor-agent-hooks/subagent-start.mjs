#!/usr/bin/env node
// subagentStart — clone active parent trace onto subagent keys so MCP/llm hooks share the tree.
import {
  readStdinJson,
  readState,
  writeState,
  sessionKey,
  run,
} from "./lib.mjs";

run(async () => {
  const input = await readStdinJson();
  const parentId = input.parent_conversation_id || sessionKey(input);
  if (!parentId) return;

  const parent = readState(parentId);
  if (!parent?.trace_id || parent.active === false) {
    // Allow subagent creation; just no obs linkage
    return;
  }

  const clone = {
    ...parent,
    sidechain: "1",
    subagent_id: input.subagent_id ?? null,
    subagent_type: input.subagent_type ?? null,
    parent_conversation_id: parentId,
    // Keep root prompt/trace; do not reset started_at (duration stays task-level on main root)
    last_assistant_text: "",
    pending_spans: Array.isArray(parent.pending_spans) ? parent.pending_spans : [],
  };

  const keys = new Set();
  if (input.subagent_id) keys.add(input.subagent_id);
  const conv = sessionKey(input);
  if (conv) keys.add(conv);
  // Some Cursor builds may key later hooks by tool_call_id
  if (input.tool_call_id) keys.add(input.tool_call_id);

  for (const k of keys) {
    if (k === parentId) continue;
    writeState(k, { ...clone, session_id: parent.session_id });
  }
});
