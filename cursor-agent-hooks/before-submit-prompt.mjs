#!/usr/bin/env node
// beforeSubmitPrompt — mint a trace for a triggered user turn.
import crypto from "node:crypto";
import {
  readStdinJson,
  readState,
  writeState,
  sessionKey,
  isTriggered,
  promptForTrigger,
  mlAppFrom,
  debugLog,
  run,
} from "./lib.mjs";

function allowContinue() {
  process.stdout.write(JSON.stringify({ continue: true }) + "\n");
}

run(async () => {
  const input = await readStdinJson();
  const key = sessionKey(input);
  const promptText = promptForTrigger(input);
  const triggered = Boolean(key) && isTriggered(promptText);

  debugLog("beforeSubmitPrompt", {
    has_key: Boolean(key),
    key: key ?? null,
    triggered,
    prompt_head: promptText.slice(0, 120),
    hook_event_name: input?.hook_event_name ?? null,
    cwd: process.cwd(),
    obs_dir_env: process.env.DBDOG_OBS_DIR ?? null,
  });

  // Always emit continue — empty stdout is treated as hook failure by Cursor CLI.
  if (!key) {
    allowContinue();
    return;
  }

  if (!triggered) {
    const prev = readState(key);
    if (prev && prev.active !== false) writeState(key, { ...prev, active: false });
    allowContinue();
    return;
  }

  const traceId = crypto.randomBytes(16).toString("hex");
  const rootSpanId = traceId.slice(0, 16);

  writeState(key, {
    active: true,
    trace_id: traceId,
    root_span_id: rootSpanId,
    session_id: key,
    ml_app: mlAppFrom(input),
    prompt: promptText,
    started_at: new Date().toISOString(),
    transcript_path: input.transcript_path ?? null,
    last_assistant_text: "",
    pending_spans: [],
    sidechain: "0",
    root_emitted: false,
  });

  debugLog("beforeSubmitPrompt_minted", { key, trace_id: traceId });
  allowContinue();
});
