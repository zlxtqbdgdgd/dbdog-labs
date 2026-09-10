#!/usr/bin/env node
// preToolUse — inject telemetry.trace_id / parent_span_id into dbdog MCP tool args.
import {
  readStdinJson,
  readActiveState,
  isDbdogMcpTool,
  parseToolInput,
  run,
} from "./lib.mjs";

run(async () => {
  const input = await readStdinJson();
  if (!isDbdogMcpTool(input.tool_name)) return;

  const { state } = readActiveState(input);
  if (!state?.trace_id) return;

  const toolInput = parseToolInput(input.tool_input);
  const telemetry =
    toolInput.telemetry && typeof toolInput.telemetry === "object" ? { ...toolInput.telemetry } : {};

  process.stdout.write(
    JSON.stringify({
      updated_input: {
        ...toolInput,
        telemetry: {
          ...telemetry,
          trace_id: state.trace_id,
          parent_span_id: state.root_span_id,
        },
      },
    }) + "\n",
  );
});
