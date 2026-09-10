import { afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HOOK_DIR = path.dirname(fileURLToPath(import.meta.url));
const tempDirs = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function tempObsDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dbdog-cursor-obs-"));
  tempDirs.push(dir);
  return dir;
}

function runHook(script, input, obsDir, extraEnv = {}) {
  const result = spawnSync(process.execPath, [path.join(HOOK_DIR, script)], {
    input: JSON.stringify(input),
    encoding: "utf8",
    env: {
      ...process.env,
      DBDOG_OBS_MODE: "triggered",
      DBDOG_OBS_TRIGGER: "诊断:",
      DBDOG_OBS_DIR: obsDir,
      DBDOG_OBS_SPANS: path.join(obsDir, "spans.jsonl"),
      ...extraEnv,
    },
  });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout;
}

function readState(obsDir, sessionId) {
  return JSON.parse(fs.readFileSync(path.join(obsDir, sessionId + ".json"), "utf8"));
}

function readSpans(obsDir) {
  const p = path.join(obsDir, "spans.jsonl");
  if (!fs.existsSync(p)) return [];
  return fs
    .readFileSync(p, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l));
}

describe("Cursor beforeSubmitPrompt trigger", () => {
  it("does not mint for ordinary prompts", () => {
    const dir = tempObsDir();
    runHook(
      "before-submit-prompt.mjs",
      { conversation_id: "plain", prompt: "看看数据库", workspace_roots: ["/tmp/proj"] },
      dir,
    );
    assert.equal(fs.existsSync(path.join(dir, "plain.json")), false);
  });

  for (const prompt of ["诊断: 看看数据库", "诊断：看看数据库", "diag: inspect database"]) {
    it(`mints active trace for ${prompt}`, () => {
      const dir = tempObsDir();
      runHook(
        "before-submit-prompt.mjs",
        { conversation_id: "t1", prompt, workspace_roots: ["/tmp/myapp"] },
        dir,
      );
      const state = readState(dir, "t1");
      assert.equal(state.active, true);
      assert.match(state.trace_id, /^[0-9a-f]{32}$/);
      assert.equal(state.root_span_id, state.trace_id.slice(0, 16));
      assert.equal(state.ml_app, "myapp");
    });
  }

  it("deactivates previous trace on untriggered follow-up", () => {
    const dir = tempObsDir();
    runHook(
      "before-submit-prompt.mjs",
      { conversation_id: "same", prompt: "诊断: first", workspace_roots: ["/tmp"] },
      dir,
    );
    runHook(
      "before-submit-prompt.mjs",
      { conversation_id: "same", prompt: "ordinary", workspace_roots: ["/tmp"] },
      dir,
    );
    assert.equal(readState(dir, "same").active, false);
  });
});

describe("Cursor preToolUse inject + tool span chain", () => {
  it("injects telemetry and records intent/input/output on afterMCPExecution", () => {
    const dir = tempObsDir();
    runHook(
      "before-submit-prompt.mjs",
      { conversation_id: "c1", prompt: "诊断: health", workspace_roots: ["/tmp/app"] },
      dir,
    );
    const state = readState(dir, "c1");

    const out = runHook(
      "pre-tool-use.mjs",
      {
        conversation_id: "c1",
        tool_name: "MCP:get_dbdog_metric",
        tool_input: { query: "avg:cpu", telemetry: { intent: "check cpu" } },
      },
      dir,
    );
    const updated = JSON.parse(out).updated_input;
    assert.equal(updated.telemetry.intent, "check cpu");
    assert.equal(updated.telemetry.trace_id, state.trace_id);
    assert.equal(updated.telemetry.parent_span_id, state.root_span_id);

    runHook(
      "after-mcp-execution.mjs",
      {
        conversation_id: "c1",
        tool_name: "MCP:get_dbdog_metric",
        tool_input: JSON.stringify({
          query: "avg:cpu",
          telemetry: {
            intent: "check cpu",
            trace_id: state.trace_id,
            parent_span_id: state.root_span_id,
          },
        }),
        result_json: JSON.stringify({ series: [{ point: 1 }] }),
        duration: 42,
      },
      dir,
    );

    const tools = readSpans(dir).filter((s) => s.kind === "tool");
    assert.equal(tools.length, 1);
    assert.equal(tools[0].name, "get_dbdog_metric");
    assert.equal(tools[0].intent, "check cpu");
    assert.equal(tools[0].input, JSON.stringify({ query: "avg:cpu" }));
    assert.match(tools[0].output, /series/);
    assert.equal(tools[0].duration_ms, 42);
    assert.equal(tools[0].status, "ok");
    assert.equal(tools[0].parent_id, state.root_span_id);
  });

  it("writes hypothesis tags from formatted intent onto the tool span", () => {
    const dir = tempObsDir();
    runHook(
      "before-submit-prompt.mjs",
      { conversation_id: "c-hypo", prompt: "诊断: x", workspace_roots: ["/tmp"] },
      dir,
    );
    const state = readState(dir, "c-hypo");
    const intent = "[H2.1<H2] 类型=根因; 假设=EXISTS 被提升; 判据=无 SubPlan 则成立; 意图=读计划";
    runHook(
      "after-mcp-execution.mjs",
      {
        conversation_id: "c-hypo",
        tool_name: "MCP:get_dbdog_database_explain_plans",
        tool_input: JSON.stringify({
          telemetry: { intent, trace_id: state.trace_id, parent_span_id: state.root_span_id },
        }),
        result_json: "{}",
      },
      dir,
    );
    const tool = readSpans(dir).find((s) => s.kind === "tool");
    assert.equal(tool.tags.hypothesis_id, "H2.1");
    assert.equal(tool.tags.parent_hypothesis_id, "H2");
    assert.equal(tool.tags.hypothesis_type, "cause");
    assert.equal(tool.tags.hypothesis, "EXISTS 被提升");
  });

  it("records error tool span on postToolUseFailure", () => {
    const dir = tempObsDir();
    runHook(
      "before-submit-prompt.mjs",
      { conversation_id: "c2", prompt: "诊断: x", workspace_roots: ["/tmp"] },
      dir,
    );
    runHook(
      "post-tool-use-failure.mjs",
      {
        conversation_id: "c2",
        tool_name: "MCP:search_dbdog_logs",
        tool_input: { query: "error", telemetry: { intent: "find errors" } },
        error_message: "timeout",
        failure_type: "timeout",
        duration: 5000,
      },
      dir,
    );
    const tool = readSpans(dir).find((s) => s.kind === "tool");
    assert.equal(tool.status, "error");
    assert.equal(tool.intent, "find errors");
    assert.equal(tool.output, "timeout");
    assert.equal(tool.tags.failure_type, "timeout");
  });

  it("skips non-dbdog MCP tools", () => {
    const dir = tempObsDir();
    runHook(
      "before-submit-prompt.mjs",
      { conversation_id: "c3", prompt: "诊断: x", workspace_roots: ["/tmp"] },
      dir,
    );
    const out = runHook(
      "pre-tool-use.mjs",
      {
        conversation_id: "c3",
        tool_name: "MCP:search_datadog_logs",
        tool_input: { query: "x", telemetry: { intent: "nope" } },
      },
      dir,
    );
    assert.equal(out, "");
  });
});

describe("Cursor llm + root + subagent", () => {
  it("emits llm and root spans; subagent shares trace_id", () => {
    const dir = tempObsDir();
    runHook(
      "before-submit-prompt.mjs",
      { conversation_id: "parent", prompt: "诊断: sub", workspace_roots: ["/tmp/diag"] },
      dir,
    );
    const parent = readState(dir, "parent");

    runHook(
      "after-agent-thought.mjs",
      { conversation_id: "parent", text: "thinking…", duration_ms: 12 },
      dir,
    );
    runHook(
      "after-agent-response.mjs",
      { conversation_id: "parent", text: "partial", model: "test-model" },
      dir,
    );

    runHook(
      "subagent-start.mjs",
      {
        conversation_id: "parent",
        parent_conversation_id: "parent",
        subagent_id: "child-1",
        subagent_type: "generalPurpose",
        task: "look up metrics",
      },
      dir,
    );
    const child = readState(dir, "child-1");
    assert.equal(child.trace_id, parent.trace_id);
    assert.equal(child.sidechain, "1");

    runHook(
      "after-mcp-execution.mjs",
      {
        conversation_id: "child-1",
        tool_name: "MCP:find_dbdog_database_instances",
        tool_input: JSON.stringify({
          telemetry: { intent: "list instances", trace_id: child.trace_id, parent_span_id: child.root_span_id },
        }),
        result_json: "[]",
        duration: 9,
      },
      dir,
    );

    runHook("subagent-stop.mjs", { conversation_id: "child-1", status: "completed" }, dir);

    runHook(
      "after-agent-response.mjs",
      { conversation_id: "parent", text: "最终结论", model: "test-model" },
      dir,
    );
    runHook("stop.mjs", { conversation_id: "parent", status: "completed" }, dir);

    const spans = readSpans(dir);
    const root = spans.filter((s) => s.kind === "agent");
    assert.equal(root.length, 1);
    assert.equal(root[0].name, "cursor-agent.task");
    assert.equal(root[0].input, "诊断: sub");
    assert.equal(root[0].output, "最终结论");

    const llm = spans.filter((s) => s.kind === "llm");
    assert.ok(llm.some((s) => s.name === "cursor.thought"));
    assert.ok(llm.some((s) => s.output === "最终结论"));

    const tools = spans.filter((s) => s.kind === "tool");
    assert.equal(tools.length, 1);
    assert.equal(tools[0].name, "find_dbdog_database_instances");
    assert.equal(tools[0].intent, "list instances");
    assert.equal(tools[0].tags.sidechain, "1");
    assert.equal(new Set(spans.map((s) => s.trace_id)).size, 1);
  });
});
