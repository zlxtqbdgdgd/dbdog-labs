#!/usr/bin/env node
import { readStdinJson, debugLog, run } from "./lib.mjs";
run(async () => {
  const input = await readStdinJson();
  debugLog("sessionStart", {
    conversation_id: input?.conversation_id ?? null,
    cwd: process.cwd(),
    composer_mode: input?.composer_mode ?? null,
  });
  process.stdout.write(JSON.stringify({ continue: true }) + "\n");
});
