import { afterEach, describe, expect, it } from "vitest";
import { spawn, spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HOOK_DIR = path.dirname(fileURLToPath(import.meta.url));
const tempDirs = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function tempObsDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dbdog-obs-hooks-"));
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
      // 上报通道默认掐断：开发机的 shell 里通常真配着 DBDOG_OBS_REPORT_URL/API_KEY
      // （~/.dbdog/llmobs-obs.env 经 .zshenv 注入），继承下来会把夹具真的报到生产平台上去。
      // 2026-08-12 实测踩过：一次全套跑完在 113 上多出 11 条 ml_app=proj 的垃圾 trace。
      // 需要 sink 的用例自己用 extraEnv 覆盖（在 ...extraEnv 之前，所以覆盖得掉）。
      DBDOG_OBS_REPORT_URL: "",
      DBDOG_OBS_API_KEY: "",
      ...extraEnv,
    },
  });
  expect(result.status, result.stderr).toBe(0);
  return result.stdout;
}

function readState(obsDir, sessionId) {
  return JSON.parse(fs.readFileSync(path.join(obsDir, sessionId + ".json"), "utf8"));
}

describe("Agent Obs hook trigger", () => {
  it("does not create trace state for an ordinary prompt in triggered mode", () => {
    const dir = tempObsDir();
    runHook("user-prompt-submit.mjs", { session_id: "plain", prompt: "看看数据库", cwd: "/tmp" }, dir);
    expect(fs.existsSync(path.join(dir, "plain.json"))).toBe(false);
  });

  it.each(["诊断: 看看数据库", "诊断：看看数据库", "diag: inspect database"])(
    "creates an active trace for %s",
    (prompt) => {
      const dir = tempObsDir();
      runHook("user-prompt-submit.mjs", { session_id: "triggered", prompt, cwd: "/tmp" }, dir);
      const state = readState(dir, "triggered");
      expect(state.active).toBe(true);
      expect(state.trace_id).toMatch(/^[0-9a-f]{32}$/);
      expect(state.root_span_id).toBe(state.trace_id.slice(0, 16));
    },
  );

  it("honors always and off modes", () => {
    const alwaysDir = tempObsDir();
    runHook(
      "user-prompt-submit.mjs",
      { session_id: "always", prompt: "ordinary", cwd: "/tmp" },
      alwaysDir,
      { DBDOG_OBS_MODE: "always" },
    );
    expect(readState(alwaysDir, "always").active).toBe(true);

    const offDir = tempObsDir();
    runHook(
      "user-prompt-submit.mjs",
      { session_id: "off", prompt: "诊断: should stay off", cwd: "/tmp" },
      offDir,
      { DBDOG_OBS_MODE: "off" },
    );
    expect(fs.existsSync(path.join(offDir, "off.json"))).toBe(false);
  });

  it("deactivates a previous trace and stops injecting context on an untriggered turn", () => {
    const dir = tempObsDir();
    runHook(
      "user-prompt-submit.mjs",
      { session_id: "same", prompt: "诊断: first", cwd: "/tmp" },
      dir,
    );
    const active = readState(dir, "same");
    const activeOutput = runHook(
      "pre-tool-use.mjs",
      { session_id: "same", tool_name: "mcp__dbdog__metric", tool_input: { telemetry: { intent: "inspect" } } },
      dir,
    );
    const updated = JSON.parse(activeOutput).hookSpecificOutput.updatedInput;
    expect(updated.telemetry).toEqual({
      intent: "inspect",
      trace_id: active.trace_id,
      parent_span_id: active.root_span_id,
    });

    runHook(
      "user-prompt-submit.mjs",
      { session_id: "same", prompt: "ordinary follow-up", cwd: "/tmp" },
      dir,
    );
    expect(readState(dir, "same").active).toBe(false);
    const inactiveOutput = runHook(
      "pre-tool-use.mjs",
      { session_id: "same", tool_name: "mcp__dbdog__metric", tool_input: { telemetry: { intent: "inspect" } } },
      dir,
    );
    expect(inactiveOutput).toBe("");
  });

  // —— 后台子代理的收尾不得被 task-notification 关掉 trace（2026-08-12）——
  // 实测：一条 trace 起了 4 个子代理，只有 1 个留下了自己的 span。上游 Claude Code 的
  // Agent 工具是即时返回的后台派发（父侧 tool span 时长只有 2–7ms），子代理跑完靠往会话里
  // 注入一轮 `<task-notification>` 通知。那一轮同样走 UserPromptSubmit，prompt 不带触发词，
  // 于是把 trace 置成 active:false，之后 3 个子代理的 SubagentStop 全被 run() 的门挡掉。
  // 证据：主 transcript 里 origin.kind=task-notification 的四轮，时刻与 state 被置 false 对上；
  // 唯一活下来的那个子代理，SubagentStop 恰好早于第一条通知。
  it("注入的 task-notification 一轮不算新提问：不关 trace、不铸新 trace、不动游标", () => {
    const dir = tempObsDir();
    runHook("user-prompt-submit.mjs", { session_id: "bg", prompt: "诊断: 起几个子代理", cwd: "/tmp" }, dir);
    const before = readState(dir, "bg");
    expect(before.active).toBe(true);

    runHook(
      "user-prompt-submit.mjs",
      {
        session_id: "bg",
        prompt: "<task-notification>\n<task-id>a8d8919de01bc1437</task-id>\n<status>completed</status>\n</task-notification>",
        cwd: "/tmp",
      },
      dir,
    );

    const after = readState(dir, "bg");
    expect(after.active).toBe(true);
    expect(after.trace_id).toBe(before.trace_id);
    expect(after.started_at).toBe(before.started_at);
    expect(after.cursor).toBe(before.cursor);
  });

  it("宿主若直接给出 origin.kind=task-notification，同样按注入轮处理", () => {
    const dir = tempObsDir();
    runHook("user-prompt-submit.mjs", { session_id: "bgo", prompt: "诊断: 起几个子代理", cwd: "/tmp" }, dir);
    runHook(
      "user-prompt-submit.mjs",
      { session_id: "bgo", prompt: "子代理回来了", cwd: "/tmp", origin: { kind: "task-notification" } },
      dir,
    );
    expect(readState(dir, "bgo").active).toBe(true);
  });

  it("真正不带触发词的用户提问照旧关掉 trace（别把门放松过头）", () => {
    const dir = tempObsDir();
    runHook("user-prompt-submit.mjs", { session_id: "plainoff", prompt: "诊断: first", cwd: "/tmp" }, dir);
    runHook("user-prompt-submit.mjs", { session_id: "plainoff", prompt: "顺便说下天气", cwd: "/tmp" }, dir);
    expect(readState(dir, "plainoff").active).toBe(false);
  });
});

// —— Stop 合成（llm + tool span；2026-07-15 起 tool span 客户端合成，服务端双写退役）——

function writeTranscript(dir, name, entries) {
  const p = path.join(dir, name);
  fs.writeFileSync(p, entries.map((e) => JSON.stringify(e)).join("\n") + "\n");
  return p;
}

function seedState(dir, sessionId, transcriptPath, extra = {}) {
  const traceId = "a".repeat(32);
  const state = {
    active: true,
    trace_id: traceId,
    root_span_id: traceId.slice(0, 16),
    session_id: sessionId,
    ml_app: "testapp",
    prompt: "诊断: 为什么卡住",
    started_at: "2026-07-15T00:00:00.000Z",
    transcript_path: transcriptPath,
    cursor: 0,
    root_emitted: false,
    ...extra,
  };
  fs.writeFileSync(path.join(dir, sessionId + ".json"), JSON.stringify(state));
  return state;
}

function readSpansSafe(dir) {
  return fs.existsSync(path.join(dir, "spans.jsonl")) ? readSpans(dir) : [];
}

function readSpans(dir) {
  return fs
    .readFileSync(path.join(dir, "spans.jsonl"), "utf8")
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l));
}

const T = (s) => `2026-07-15T00:00:${s}Z`;

describe("Stop hook span synthesis", () => {
  it("synthesizes llm spans (estimated duration) and tool spans (local + mcp + failed) from the transcript", () => {
    const dir = tempObsDir();
    const transcript = writeTranscript(dir, "t.jsonl", [
      { type: "user", timestamp: T("00.000"), message: { role: "user", content: "诊断: 为什么卡住" } },
      {
        type: "assistant",
        timestamp: T("05.000"),
        requestId: "req_1",
        isSidechain: false,
        message: {
          model: "claude-fable-5",
          usage: { input_tokens: 3, output_tokens: 50, cache_read_input_tokens: 7, cache_creation_input_tokens: 9 },
          content: [
            { type: "text", text: "先看进程" },
            { type: "tool_use", id: "tu_local", name: "Bash", input: { command: "ls" } },
            {
              type: "tool_use",
              id: "tu_mcp",
              name: "mcp__dbdog-mcp__get_llmobs_trace",
              input: {
                trace_id: "beef",
                telemetry: { intent: "look up trace", trace_id: "a".repeat(32), parent_span_id: "a".repeat(16) },
              },
            },
          ],
        },
      },
      {
        type: "user",
        timestamp: T("07.500"),
        message: {
          role: "user",
          content: [{ type: "tool_result", tool_use_id: "tu_local", content: "file1\nfile2" }],
        },
      },
      {
        type: "user",
        timestamp: T("09.000"),
        message: {
          role: "user",
          content: [
            {
              type: "tool_result",
              tool_use_id: "tu_mcp",
              is_error: true,
              content: [{ type: "text", text: "Streamable HTTP error: socket dropped" }],
            },
          ],
        },
      },
      {
        type: "assistant",
        timestamp: T("20.000"),
        requestId: "req_2",
        isSidechain: false,
        message: {
          model: "claude-fable-5",
          usage: { input_tokens: 2, output_tokens: 80 },
          content: [{ type: "text", text: "结论如下" }],
        },
      },
    ]);
    seedState(dir, "s1", transcript);

    runHook("stop.mjs", { session_id: "s1", transcript_path: transcript, hook_event_name: "Stop", last_assistant_message: "结论如下" }, dir);
    const spans = readSpans(dir);

    const llm = spans.filter((s) => s.kind === "llm");
    expect(llm).toHaveLength(2);
    // 时长近似：前一条 entry 落盘 → 组内末行落盘，且打估算标
    expect(llm[0].duration_ms).toBe(5000);
    expect(llm[0].tags.duration_estimated).toBe("1");
    expect(llm[1].duration_ms).toBe(11000);

    const tools = spans.filter((s) => s.kind === "tool");
    expect(tools).toHaveLength(2);
    const local = tools.find((s) => s.name === "Bash");
    expect(local.status).toBe("ok");
    expect(local.duration_ms).toBe(2500);
    expect(local.input).toBe(JSON.stringify({ command: "ls" }));
    expect(local.output).toBe("file1\nfile2");
    expect(local.parent_id).toBe("a".repeat(16));
    expect(local.session_id).toBe("s1");
    expect(local.tags.ml_app).toBe("testapp");

    // MCP 工具：名字剥前缀、telemetry 块剥离、intent 提为一等字段；失败调用也留 span
    const mcp = tools.find((s) => s.name === "get_llmobs_trace");
    expect(mcp.status).toBe("error");
    expect(mcp.tags.mcp_server).toBe("dbdog-mcp");
    expect(mcp.intent).toBe("look up trace");
    expect(mcp.input).toBe(JSON.stringify({ trace_id: "beef" }));
    expect(mcp.output).toContain("socket dropped");

    // 全部 span 同一 session（缺口④a：不再出现服务端会话号）
    expect(new Set(spans.map((s) => s.session_id))).toEqual(new Set(["s1"]));
    const root = spans.find((s) => s.kind === "agent");
    expect(root.output).toBe("结论如下");
  });

  it("pairs a tool_use with a tool_result that arrives in a later batch", () => {
    const dir = tempObsDir();
    const use = {
      type: "assistant",
      timestamp: T("01.000"),
      requestId: "req_1",
      message: {
        model: "m",
        usage: { input_tokens: 1, output_tokens: 1 },
        content: [{ type: "tool_use", id: "tu_x", name: "Read", input: { file_path: "/a" } }],
      },
    };
    const result = {
      type: "user",
      timestamp: T("04.000"),
      message: { role: "user", content: [{ type: "tool_result", tool_use_id: "tu_x", content: "data" }] },
    };
    const transcript = writeTranscript(dir, "t.jsonl", [use]);
    seedState(dir, "s2", transcript);

    runHook("stop.mjs", { session_id: "s2", transcript_path: transcript, hook_event_name: "Stop" }, dir);
    expect(readSpans(dir).filter((s) => s.kind === "tool")).toHaveLength(0);
    expect(Object.keys(readState(dir, "s2").pending_tool_uses)).toEqual(["tu_x"]);

    fs.appendFileSync(transcript, JSON.stringify(result) + "\n");
    runHook("stop.mjs", { session_id: "s2", transcript_path: transcript, hook_event_name: "Stop" }, dir);
    const tool = readSpans(dir).find((s) => s.kind === "tool");
    expect(tool.name).toBe("Read");
    expect(tool.duration_ms).toBe(3000);
    expect(tool.status).toBe("ok");
  });
});

// —— llm span 本地完整 prompt（input_local，2026-08-10）——
// 上报侧 input 恒 null，完整 prompt 只在 spans.jsonl 里（DBDOG_OBS_STORE_LLM_INPUT 可关），
// reportSpans 前剥离。快照取"该轮模型调用之前的滚动上下文"，截尾存。
describe("llm span 本地完整 prompt", () => {
  it("accumulates the context per round into input_local, tool_use args excluded", () => {
    const dir = tempObsDir();
    const transcript = writeTranscript(dir, "t.jsonl", [
      { type: "user", timestamp: T("00.000"), message: { role: "user", content: "诊断: 为什么卡住" } },
      {
        type: "assistant",
        timestamp: T("05.000"),
        requestId: "req_1",
        message: {
          model: "m",
          usage: { input_tokens: 3, output_tokens: 50 },
          content: [
            { type: "text", text: "先看进程" },
            { type: "tool_use", id: "tu_local", name: "Bash", input: { command: "ls" } },
          ],
        },
      },
      {
        type: "user",
        timestamp: T("07.500"),
        message: { role: "user", content: [{ type: "tool_result", tool_use_id: "tu_local", content: "file1\nfile2" }] },
      },
      {
        type: "assistant",
        timestamp: T("20.000"),
        requestId: "req_2",
        message: { model: "m", usage: { input_tokens: 2, output_tokens: 80 }, content: [{ type: "text", text: "结论如下" }] },
      },
    ]);
    seedState(dir, "s1", transcript);

    runHook("stop.mjs", { session_id: "s1", transcript_path: transcript, hook_event_name: "Stop", last_assistant_message: "结论如下" }, dir);
    const llm = readSpans(dir).filter((s) => s.kind === "llm");
    expect(llm).toHaveLength(2);
    // 第 1 轮的 prompt = 初始用户消息（快照取在本次输出入缓冲之前）
    expect(llm[0].input_local).toBe("[user]\n诊断: 为什么卡住");
    // 上报视角 input 恒 null，不随 input_local 变化
    expect(llm[0].input).toBeNull();
    // 第 2 轮的 prompt = 初始消息 + 第 1 轮输出 + tool_result 注入
    expect(llm[1].input_local).toContain("[user]\n诊断: 为什么卡住");
    expect(llm[1].input_local).toContain("[assistant]\n先看进程");
    expect(llm[1].input_local).toContain("[tool_result tu_local]\nfile1\nfile2");
    // tool_use 只留名字标记，参数不进缓冲（tool span 已存全文）
    expect(llm[1].input_local).toContain("[tool_use: Bash]");
    expect(llm[1].input_local).not.toContain('"command"');
  });

  it("caps the context buffer and tail-caps the snapshot", () => {
    const dir = tempObsDir();
    const transcript = writeTranscript(dir, "t.jsonl", [
      { type: "user", timestamp: T("00.000"), message: { role: "user", content: "A".repeat(60) } },
      {
        type: "assistant",
        timestamp: T("05.000"),
        requestId: "req_1",
        message: { model: "m", usage: { input_tokens: 3, output_tokens: 50 }, content: [{ type: "text", text: "x" }] },
      },
    ]);
    seedState(dir, "s1", transcript);
    runHook("stop.mjs", { session_id: "s1", transcript_path: transcript, hook_event_name: "Stop" }, dir, {
      DBDOG_OBS_CTX_BUF_CHARS: "40",
      DBDOG_OBS_CONTENT_CHARS: "10",
    });
    const llm = readSpans(dir).find((s) => s.kind === "llm");
    // 缓冲截尾（"[user]\n" + 60 个 A → 剩尾部 40 个 A），快照再截尾到 contentCap=10
    expect(llm.input_local).toBe("A".repeat(10));
  });

  it("omits input_local when DBDOG_OBS_STORE_LLM_INPUT=0", () => {
    const dir = tempObsDir();
    const transcript = writeTranscript(dir, "t.jsonl", [
      { type: "user", timestamp: T("00.000"), message: { role: "user", content: "诊断: 为什么卡住" } },
      {
        type: "assistant",
        timestamp: T("05.000"),
        requestId: "req_1",
        message: { model: "m", usage: { input_tokens: 3, output_tokens: 50 }, content: [{ type: "text", text: "x" }] },
      },
    ]);
    seedState(dir, "s1", transcript);
    runHook("stop.mjs", { session_id: "s1", transcript_path: transcript, hook_event_name: "Stop" }, dir, {
      DBDOG_OBS_STORE_LLM_INPUT: "0",
    });
    expect(readSpans(dir).find((s) => s.kind === "llm").input_local).toBeUndefined();
  });

  it("keeps input_local out of the reported payload: local JSONL has it, sink does not", async () => {
    const dir = tempObsDir();
    const sink = await startSpanSink();
    try {
      const transcript = writeTranscript(dir, "t.jsonl", [
        { type: "user", timestamp: T("00.000"), message: { role: "user", content: "诊断: 为什么卡住" } },
        {
          type: "assistant",
          timestamp: T("05.000"),
          requestId: "req_1",
          message: { model: "m", usage: { input_tokens: 3, output_tokens: 50 }, content: [{ type: "text", text: "x" }] },
        },
      ]);
      seedState(dir, "s1", transcript);
      await runHookAsync(
        "stop.mjs",
        { session_id: "s1", transcript_path: transcript, hook_event_name: "Stop" },
        dir,
        { DBDOG_OBS_REPORT_URL: sink.url, DBDOG_OBS_API_KEY: "test-key" },
      );
      expect(readSpans(dir).find((s) => s.kind === "llm").input_local).toBe("[user]\n诊断: 为什么卡住");
      const reported = sink.received.find((s) => s.kind === "llm");
      expect(reported).toBeDefined();
      expect(reported.input_local).toBeUndefined();
    } finally {
      await sink.close();
    }
  });
});

// —— 子代理路径追踪（2026-08-09）——
// 上游 Claude Code 2.1.x 把子代理会话流水拆成独立文件 <session>/subagents/agent-<id>.jsonl，
// 主 transcript 里不再有 isSidechain 行。SubagentStop 实测入参：
//   transcript_path        = 主 transcript（与 Stop 相同）
//   agent_transcript_path  = 子代理那份
//   agent_id / agent_type  = 子代理身份
// 父子关联锚点：父侧 Agent 工具的 tool_result 行带 toolUseResult.agentId，与 agent_id 精确对上。

const AGENT_ID = "a80d5ea9a276e0a65";

function writeSubagentTranscript(dir) {
  return writeTranscript(dir, "sub.jsonl", [
    // 实测子代理 transcript 首行即 type=user、content 为字符串的 prompt
    {
      type: "user",
      timestamp: T("01.500"),
      isSidechain: true,
      agentId: AGENT_ID,
      message: { role: "user", content: "跑 echo hi 并把 stdout 报回来" },
    },
    {
      type: "assistant",
      timestamp: T("02.000"),
      requestId: "req_sub",
      isSidechain: true,
      agentId: AGENT_ID,
      message: {
        model: "claude-opus-5",
        usage: { input_tokens: 5, output_tokens: 9 },
        content: [
          { type: "text", text: "先跑一下" },
          { type: "tool_use", id: "tu_sub", name: "Bash", input: { command: "echo hi" } },
        ],
      },
    },
    {
      type: "user",
      timestamp: T("03.500"),
      isSidechain: true,
      agentId: AGENT_ID,
      message: { role: "user", content: [{ type: "tool_result", tool_use_id: "tu_sub", content: "hi" }] },
    },
  ]);
}

function writeParentTranscript(dir) {
  return writeTranscript(dir, "main.jsonl", [
    { type: "user", timestamp: T("00.000"), message: { role: "user", content: "诊断: 起个子代理" } },
    {
      type: "assistant",
      timestamp: T("01.000"),
      requestId: "req_main",
      message: {
        model: "claude-opus-5",
        usage: { input_tokens: 1, output_tokens: 2 },
        content: [
          {
            type: "tool_use",
            id: "toolu_agent",
            name: "Agent",
            input: { subagent_type: "general-purpose", prompt: "跑 echo" },
          },
        ],
      },
    },
    {
      type: "user",
      timestamp: T("05.000"),
      toolUseResult: {
        agentId: AGENT_ID,
        agentType: "general-purpose",
        resolvedModel: "claude-opus-5[1m]",
        status: "completed",
        totalDurationMs: 4000,
        totalTokens: 20624,
        totalToolUseCount: 3,
      },
      message: { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_agent", content: "hi" }] },
    },
  ]);
}

describe("subagent path tracing", () => {
  it("synthesizes the subagent's own tool spans from agent_transcript_path", () => {
    const dir = tempObsDir();
    const main = writeParentTranscript(dir);
    const sub = writeSubagentTranscript(dir);
    seedState(dir, "s3", main);

    runHook(
      "stop.mjs",
      {
        session_id: "s3",
        transcript_path: main,
        agent_transcript_path: sub,
        agent_id: AGENT_ID,
        agent_type: "general-purpose",
        hook_event_name: "SubagentStop",
      },
      dir,
    );

    const bash = readSpans(dir).find((s) => s.kind === "tool" && s.name === "Bash");
    expect(bash, "子代理内部的 Bash 调用应合成 tool span").toBeDefined();
    expect(bash.output).toBe("hi");
    expect(bash.duration_ms).toBe(1500);
    expect(bash.tags.sidechain).toBe("1");
    expect(bash.tags.agent_id).toBe(AGENT_ID);
    expect(bash.tags.agent_type).toBe("general-purpose");
  });

  it("emits an agent span for the subagent itself", () => {
    const dir = tempObsDir();
    const main = writeParentTranscript(dir);
    const sub = writeSubagentTranscript(dir);
    seedState(dir, "s7", main);

    runHook(
      "stop.mjs",
      {
        session_id: "s7",
        transcript_path: main,
        agent_transcript_path: sub,
        agent_id: AGENT_ID,
        agent_type: "general-purpose",
        hook_event_name: "SubagentStop",
        last_assistant_message: "stdout 是 hi",
      },
      dir,
    );

    const subAgent = readSpans(dir).find((s) => s.kind === "agent");
    expect(subAgent, "子代理应有自己的 agent span").toBeDefined();
    expect(subAgent.name).toBe("claude-code.subagent");
    expect(subAgent.input).toBe("跑 echo hi 并把 stdout 报回来"); // 子代理 transcript 首行
    expect(subAgent.output).toBe("stdout 是 hi"); // SubagentStop 的 last_assistant_message
    expect(subAgent.ts).toBe(T("01.500"));
    expect(subAgent.duration_ms).toBe(2000); // 首条 → 末条 entry
    expect(subAgent.tags.sidechain).toBe("1");
    expect(subAgent.tags.agent_id).toBe(AGENT_ID);
    expect(subAgent.tags.agent_type).toBe("general-purpose");
  });

  it("nests three levels: root → parent-side Agent tool → subagent → its own calls", () => {
    const dir = tempObsDir();
    const main = writeParentTranscript(dir);
    const sub = writeSubagentTranscript(dir);
    seedState(dir, "s4", main);

    runHook(
      "stop.mjs",
      {
        session_id: "s4",
        transcript_path: main,
        agent_transcript_path: sub,
        agent_id: AGENT_ID,
        agent_type: "general-purpose",
        hook_event_name: "SubagentStop",
        last_assistant_message: "stdout 是 hi",
      },
      dir,
    );
    runHook(
      "stop.mjs",
      { session_id: "s4", transcript_path: main, hook_event_name: "Stop", last_assistant_message: "done" },
      dir,
    );

    const spans = readSpans(dir);
    const root = spans.find((s) => s.kind === "agent" && s.name === "claude-code.task");
    const agentTool = spans.find((s) => s.kind === "tool" && s.name === "Agent");
    const subAgent = spans.find((s) => s.kind === "agent" && s.name === "claude-code.subagent");
    const bash = spans.find((s) => s.kind === "tool" && s.name === "Bash");
    const subLlm = spans.find((s) => s.kind === "llm" && s.tags.sidechain === "1");

    expect(agentTool, "父侧 Agent 调用应有 tool span").toBeDefined();
    expect(agentTool.parent_id).toBe(root.span_id);
    expect(subAgent.parent_id).toBe(agentTool.span_id);
    // 子代理内部的调用挂子代理自己的 agent span，不再直接挂父侧 tool span
    expect(bash.parent_id).toBe(subAgent.span_id);
    expect(subLlm.parent_id).toBe(subAgent.span_id);
  });

  it("stays a no-op when SubagentStop carries no agent_transcript_path", () => {
    // 老版 Claude Code 不给 agent_transcript_path（那会儿子代理内容就写在主 transcript 里，
    // Stop 一并读得到）。此时必须原地不动——尤其不能去读主 transcript、推主游标。
    const dir = tempObsDir();
    const main = writeParentTranscript(dir);
    seedState(dir, "s6", main);

    runHook("stop.mjs", { session_id: "s6", transcript_path: main, hook_event_name: "SubagentStop" }, dir);

    expect(fs.existsSync(path.join(dir, "spans.jsonl"))).toBe(false);
    expect(readState(dir, "s6").cursor).toBe(0);
  });

  it("leaves the main transcript cursor untouched on SubagentStop", () => {
    // 并发安全：并行子代理会同时触发 SubagentStop，若各自读-改-写主 state，
    // 后写覆盖先写 → 主游标错乱。SubagentStop 只该碰子代理那份。
    const dir = tempObsDir();
    const main = writeParentTranscript(dir);
    const sub = writeSubagentTranscript(dir);
    seedState(dir, "s5", main);
    const before = readState(dir, "s5").cursor;

    runHook(
      "stop.mjs",
      {
        session_id: "s5",
        transcript_path: main,
        agent_transcript_path: sub,
        agent_id: AGENT_ID,
        agent_type: "general-purpose",
        hook_event_name: "SubagentStop",
      },
      dir,
    );

    expect(readState(dir, "s5").cursor).toBe(before);
  });
});


// —— 收尸：补发卡死的 pending + 清理过期状态文件（2026-08-09）——
// 背景：上报失败的 span 存进状态文件的 pending_spans 等下次重试，但 session 结束后
// 就再没有下一轮触发，永久卡死（实测一台机器积压 737 条从未送达）。
// sweep.mjs 独立于触发门运行，专门收尸。
// 并发保险丝：只碰 mtime 足够老的状态文件——那种文件的会话必已结束，没有写者。

/** 起一个真实的 span 接收端，验证补发走通网络路径（而非 mock 掉 reportSpans）。 */
async function startSpanSink() {
  const received = [];
  const batches = [];
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      try {
        const spans = JSON.parse(body).spans ?? [];
        batches.push(spans.length);
        received.push(...spans);
      } catch {
        /* 坏 body 计为收到 0 条 */
      }
      res.writeHead(202, { "content-type": "application/json" });
      res.end("{}");
    });
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  return {
    url: `http://127.0.0.1:${server.address().port}/api/v2/llmobs/spans`,
    received,
    batches,
    close: () => new Promise((r) => server.close(r)),
  };
}

/**
 * 异步跑脚本——必须异步：sweep 会 POST 到本测试进程内起的 sink server，
 * 用 spawnSync 会阻塞 vitest 的事件循环，server 根本没机会响应，
 * 每次都得等满 reportSpans 的 3s 超时然后判失败。
 */
function runScript(script, obsDir, extraEnv = {}, input) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [path.join(HOOK_DIR, script)], {
      env: {
        ...process.env,
        DBDOG_OBS_DIR: obsDir,
        DBDOG_OBS_SPANS: path.join(obsDir, "spans.jsonl"),
        // 同 runHook：默认掐断上报，别把夹具报到生产平台（需要 sink 的用例用 extraEnv 覆盖）
        DBDOG_OBS_REPORT_URL: "",
        DBDOG_OBS_API_KEY: "",
        ...extraEnv,
      },
    });
    if (input !== undefined) child.stdin.write(input);
    child.stdin.end();
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));
    child.on("error", reject);
    child.on("close", (code) => {
      expect(code, stderr).toBe(0);
      resolve(stdout);
    });
  });
}

/** 需要 sink 响应的 hook 调用必须走异步版，理由同 runScript。 */
function runHookAsync(script, input, obsDir, extraEnv = {}) {
  return runScript(script, obsDir, { DBDOG_OBS_MODE: "triggered", ...extraEnv }, JSON.stringify(input));
}

/** 把文件 mtime 拨老 ms 毫秒（模拟"会话早已结束"）。 */
function ageFile(p, ms) {
  const t = (Date.now() - ms) / 1000;
  fs.utimesSync(p, t, t);
}

function writeStateFile(dir, name, state) {
  const p = path.join(dir, name);
  fs.writeFileSync(p, JSON.stringify(state));
  return p;
}

const HOUR = 3600_000;
const DAY = 24 * HOUR;

describe("sweep: 补发卡死的 pending", () => {
  it("resends a dead session's pending spans and clears them", async () => {
    const dir = tempObsDir();
    const sink = await startSpanSink();
    try {
      // spans.jsonl 是真相源；状态文件只存 span_id
      fs.writeFileSync(
        path.join(dir, "spans.jsonl"),
        [
          JSON.stringify({ trace_id: "t1", span_id: "aaaa", kind: "llm", name: "x" }),
          JSON.stringify({ trace_id: "t1", span_id: "bbbb", kind: "tool", name: "y" }),
        ].join("\n") + "\n",
      );
      const p = writeStateFile(dir, "dead.json", {
        trace_id: "t1",
        session_id: "dead",
        pending_spans: ["aaaa", "bbbb"],
      });
      ageFile(p, 3 * HOUR);

      await runScript("sweep.mjs", dir, {
        DBDOG_OBS_REPORT_URL: sink.url,
        DBDOG_OBS_API_KEY: "k",
        DBDOG_OBS_SWEEP_IDLE_MS: String(HOUR),
      });

      expect(sink.received.map((s) => s.span_id).sort()).toEqual(["aaaa", "bbbb"]);
      expect(JSON.parse(fs.readFileSync(p, "utf8")).pending_spans).toEqual([]);
    } finally {
      await sink.close();
    }
  });

  it("does not touch a state file that was written recently", async () => {
    // 并发保险丝：活跃会话的状态文件正有写者，sweep 碰它就会互相覆盖
    const dir = tempObsDir();
    const sink = await startSpanSink();
    try {
      fs.writeFileSync(
        path.join(dir, "spans.jsonl"),
        JSON.stringify({ trace_id: "t1", span_id: "aaaa", kind: "llm", name: "x" }) + "\n",
      );
      const p = writeStateFile(dir, "live.json", { trace_id: "t1", pending_spans: ["aaaa"] });
      // 不拨老 mtime = 刚写过

      await runScript("sweep.mjs", dir, {
        DBDOG_OBS_REPORT_URL: sink.url,
        DBDOG_OBS_API_KEY: "k",
        DBDOG_OBS_SWEEP_IDLE_MS: String(HOUR),
      });

      expect(sink.received).toHaveLength(0);
      expect(JSON.parse(fs.readFileSync(p, "utf8")).pending_spans).toEqual(["aaaa"]);
    } finally {
      await sink.close();
    }
  });

  it("still resends legacy pending_spans that hold full span objects", async () => {
    // 旧格式：pending_spans 里直接躺着 span 全文（正是状态文件涨到数百 KB 的原因）
    const dir = tempObsDir();
    const sink = await startSpanSink();
    try {
      const p = writeStateFile(dir, "legacy.json", {
        trace_id: "t1",
        pending_spans: [{ trace_id: "t1", span_id: "cccc", kind: "llm", name: "old" }],
      });
      ageFile(p, 3 * HOUR);

      await runScript("sweep.mjs", dir, {
        DBDOG_OBS_REPORT_URL: sink.url,
        DBDOG_OBS_API_KEY: "k",
        DBDOG_OBS_SWEEP_IDLE_MS: String(HOUR),
      });

      expect(sink.received.map((s) => s.span_id)).toEqual(["cccc"]);
      expect(JSON.parse(fs.readFileSync(p, "utf8")).pending_spans).toEqual([]);
    } finally {
      await sink.close();
    }
  });

  it("splits an oversized backlog into batches", async () => {
    // 服务端限单批 1000 条 / 5MB；实测最大的一个积压文件有 273 条含全文的 span
    const dir = tempObsDir();
    const sink = await startSpanSink();
    try {
      const ids = ["s1", "s2", "s3", "s4", "s5"];
      fs.writeFileSync(
        path.join(dir, "spans.jsonl"),
        ids.map((id) => JSON.stringify({ trace_id: "t", span_id: id, kind: "llm", name: id })).join("\n") + "\n",
      );
      const p = writeStateFile(dir, "big.json", { trace_id: "t", pending_spans: ids });
      ageFile(p, 3 * HOUR);

      await runScript("sweep.mjs", dir, {
        DBDOG_OBS_REPORT_URL: sink.url,
        DBDOG_OBS_API_KEY: "k",
        DBDOG_OBS_SWEEP_IDLE_MS: String(HOUR),
        DBDOG_OBS_SWEEP_BATCH: "2",
      });

      expect(sink.received.map((s) => s.span_id).sort()).toEqual(ids);
      expect(sink.batches).toEqual([2, 2, 1]);
      expect(JSON.parse(fs.readFileSync(p, "utf8")).pending_spans).toEqual([]);
    } finally {
      await sink.close();
    }
  });

  it("keeps pending when the sink rejects, so nothing is lost", async () => {
    const dir = tempObsDir();
    fs.writeFileSync(
      path.join(dir, "spans.jsonl"),
      JSON.stringify({ trace_id: "t1", span_id: "aaaa", kind: "llm", name: "x" }) + "\n",
    );
    const p = writeStateFile(dir, "dead.json", { trace_id: "t1", pending_spans: ["aaaa"] });
    ageFile(p, 3 * HOUR);

    await runScript("sweep.mjs", dir, {
      DBDOG_OBS_REPORT_URL: "http://127.0.0.1:1/api/v2/llmobs/spans", // 必然连不上
      DBDOG_OBS_API_KEY: "k",
      DBDOG_OBS_SWEEP_IDLE_MS: String(HOUR),
    });

    expect(JSON.parse(fs.readFileSync(p, "utf8")).pending_spans).toEqual(["aaaa"]);
    expect(fs.existsSync(p), "上报失败不得删文件").toBe(true);
  });
});

describe("sweep: 清理过期状态文件", () => {
  it("deletes drained files past their TTL and keeps the rest", async () => {
    const dir = tempObsDir();
    const expired = writeStateFile(dir, "expired.json", { trace_id: "t", pending_spans: [] });
    const fresh = writeStateFile(dir, "fresh.json", { trace_id: "t", pending_spans: [] });
    const stillPending = writeStateFile(dir, "haspending.json", {
      trace_id: "t",
      pending_spans: [{ span_id: "zzzz", trace_id: "t", kind: "llm" }],
    });
    ageFile(expired, 8 * DAY);
    ageFile(fresh, 1 * HOUR);
    ageFile(stillPending, 8 * DAY); // 过期但仍有 pending，且没配上报 → 不许删

    await runScript("sweep.mjs", dir, {
      DBDOG_OBS_SWEEP_IDLE_MS: String(HOUR),
      DBDOG_OBS_SWEEP_TTL_MS: String(7 * DAY),
    });

    expect(fs.existsSync(expired), "已排空且过期 → 删").toBe(false);
    expect(fs.existsSync(fresh), "未过期 → 留").toBe(true);
    expect(fs.existsSync(stillPending), "仍有未送达的 span → 留").toBe(true);
  });

  it("expires subagent state files on a shorter clock", async () => {
    // 子代理不会复活，排空后没有保留价值；而且并行子代理会一次留下几十个文件
    const dir = tempObsDir();
    const sub = writeStateFile(dir, "sess.a80d5ea9a276e0a65.json", { pending_spans: [] });
    const main = writeStateFile(dir, "sess.json", { trace_id: "t", pending_spans: [] });
    ageFile(sub, 2 * DAY);
    ageFile(main, 2 * DAY);

    await runScript("sweep.mjs", dir, {
      DBDOG_OBS_SWEEP_IDLE_MS: String(HOUR),
      DBDOG_OBS_SWEEP_TTL_MS: String(7 * DAY),
      DBDOG_OBS_SWEEP_SUB_TTL_MS: String(1 * DAY),
    });

    expect(fs.existsSync(sub), "子代理状态文件按短时钟过期 → 删").toBe(false);
    expect(fs.existsSync(main), "主会话状态文件未到 7 天 → 留").toBe(true);
  });

  it("never deletes spans.jsonl", async () => {
    const dir = tempObsDir();
    const spans = path.join(dir, "spans.jsonl");
    fs.writeFileSync(spans, JSON.stringify({ span_id: "aaaa", trace_id: "t", kind: "llm" }) + "\n");
    ageFile(spans, 400 * DAY);

    await runScript("sweep.mjs", dir, { DBDOG_OBS_SWEEP_TTL_MS: String(1000) });

    expect(fs.existsSync(spans), "spans.jsonl 是真相源，永远不能删").toBe(true);
  });
});

describe("pending 瘦身：状态文件只存 span_id", () => {
  /** 一条最小 transcript：一次模型调用 + 一次 Bash，够产出 llm/tool/root 三条 span。 */
  function tinyTranscript(dir) {
    return writeTranscript(dir, "tiny.jsonl", [
      { type: "user", timestamp: T("00.000"), message: { role: "user", content: "诊断: x" } },
      {
        type: "assistant",
        timestamp: T("01.000"),
        requestId: "r1",
        message: {
          model: "m",
          usage: { input_tokens: 1, output_tokens: 1 },
          content: [{ type: "tool_use", id: "tu1", name: "Bash", input: { command: "ls" } }],
        },
      },
      {
        type: "user",
        timestamp: T("02.000"),
        message: { role: "user", content: [{ type: "tool_result", tool_use_id: "tu1", content: "ok" }] },
      },
    ]);
  }

  it("keeps span ids rather than full copies when reporting fails", async () => {
    // 旧行为把 span 全文塞进状态文件，实测把单个文件撑到 315 KB
    const dir = tempObsDir();
    const transcript = tinyTranscript(dir);
    seedState(dir, "p1", transcript);

    await runHookAsync(
      "stop.mjs",
      { session_id: "p1", transcript_path: transcript, hook_event_name: "Stop", last_assistant_message: "done" },
      dir,
      { DBDOG_OBS_REPORT_URL: "http://127.0.0.1:1/api/v2/llmobs/spans", DBDOG_OBS_API_KEY: "k" },
    );

    const pending = readState(dir, "p1").pending_spans;
    expect(pending.length).toBeGreaterThan(0);
    for (const item of pending) expect(typeof item).toBe("string");

    // 每个 id 都能在 spans.jsonl（真相源）里找回全文
    const known = new Set(readSpans(dir).map((s) => s.span_id));
    for (const id of pending) expect(known.has(id)).toBe(true);
  });

  it("re-sends spans carried over from a previous failed report", async () => {
    const dir = tempObsDir();
    const transcript = tinyTranscript(dir);
    seedState(dir, "p2", transcript);

    // 第一次：上报打不通，span 落本地并记下 id
    await runHookAsync(
      "stop.mjs",
      { session_id: "p2", transcript_path: transcript, hook_event_name: "Stop", last_assistant_message: "done" },
      dir,
      { DBDOG_OBS_REPORT_URL: "http://127.0.0.1:1/api/v2/llmobs/spans", DBDOG_OBS_API_KEY: "k" },
    );
    const carried = readState(dir, "p2").pending_spans;
    expect(carried.length).toBeGreaterThan(0);

    // 第二次：通了——上一轮攒下的 id 应被回捞成全文一起发出
    const sink = await startSpanSink();
    try {
      await runHookAsync(
        "stop.mjs",
        { session_id: "p2", transcript_path: transcript, hook_event_name: "Stop", last_assistant_message: "done" },
        dir,
        { DBDOG_OBS_REPORT_URL: sink.url, DBDOG_OBS_API_KEY: "k" },
      );
      const sent = new Set(sink.received.map((s) => s.span_id));
      for (const id of carried) expect(sent.has(id), `${id} 应被补发`).toBe(true);
      // 补发的是全文，不是光秃秃的 id
      expect(sink.received.every((s) => typeof s === "object" && s.kind)).toBe(true);
      expect(readState(dir, "p2").pending_spans).toEqual([]);
    } finally {
      await sink.close();
    }
  });
});

describe("SessionStart 触发后台收尸", () => {
  async function waitFor(predicate, timeoutMs = 8000) {
    const started = Date.now();
    while (Date.now() - started < timeoutMs) {
      if (predicate()) return true;
      await new Promise((r) => setTimeout(r, 50));
    }
    return false;
  }

  it("returns immediately and sweeps in the background", async () => {
    // 收尸要发好几轮 HTTP，绝不能卡在会话启动路径上——hook 必须立刻返回，
    // 真正的活交给 detached 子进程慢慢做。
    const dir = tempObsDir();
    const expired = writeStateFile(dir, "old.json", { trace_id: "t", pending_spans: [] });
    ageFile(expired, 8 * DAY);

    const startedAt = Date.now();
    await runScript(
      "session-start.mjs",
      dir,
      { DBDOG_OBS_SWEEP_IDLE_MS: String(HOUR), DBDOG_OBS_SWEEP_TTL_MS: String(7 * DAY) },
      JSON.stringify({ session_id: "s", hook_event_name: "SessionStart" }),
    );
    expect(Date.now() - startedAt, "hook 本身必须秒回").toBeLessThan(1500);

    expect(await waitFor(() => !fs.existsSync(expired)), "后台 sweep 应清掉过期文件").toBe(true);
  }, 20000);
});

describe("新一轮触发不得丢弃未送达的 pending", () => {
  it("carries unreported pending span ids across a new trigger", () => {
    // user-prompt-submit 每轮写的是全新 state 对象。若不继承 pending_spans，
    // "这些 span 没送达"这个事实就此消失，连 sweep 也救不回来——实测有一条 trace
    // 本地 219 条、服务端只有 110 条，缺的 109 条不在任何状态文件里。
    const dir = tempObsDir();
    runHook("user-prompt-submit.mjs", { session_id: "c1", prompt: "诊断: 第一轮", cwd: "/tmp" }, dir);

    const first = readState(dir, "c1");
    first.pending_spans = ["deadbeefdeadbeef"];
    fs.writeFileSync(path.join(dir, "c1.json"), JSON.stringify(first));

    runHook("user-prompt-submit.mjs", { session_id: "c1", prompt: "诊断: 第二轮", cwd: "/tmp" }, dir);

    const second = readState(dir, "c1");
    expect(second.pending_spans).toEqual(["deadbeefdeadbeef"]);
    expect(second.trace_id).not.toBe(first.trace_id); // 确实是新一轮 trace
  });
});

describe("父侧 Agent span 带上子代理的聚合开销", () => {
  it("stamps the parent-side Agent tool span with the subagent's cost tags", () => {
    // toolUseResult 里现成就有子代理的总开销，不打上去等于白扔——
    // 有了它们，不展开子树就能看出某个子代理烧了多少 token。
    const dir = tempObsDir();
    const main = writeParentTranscript(dir);
    seedState(dir, "agg", main);

    runHook(
      "stop.mjs",
      { session_id: "agg", transcript_path: main, hook_event_name: "Stop", last_assistant_message: "done" },
      dir,
    );

    const agentTool = readSpans(dir).find((s) => s.kind === "tool" && s.name === "Agent");
    expect(agentTool.tags.agent_id).toBe(AGENT_ID);
    expect(agentTool.tags.agent_type).toBe("general-purpose");
    expect(agentTool.tags.agent_model).toBe("claude-opus-5[1m]");
    expect(agentTool.tags.agent_total_tokens).toBe("20624");
    expect(agentTool.tags.agent_tool_use_count).toBe("3");
  });

  it("leaves ordinary tool spans free of agent tags", () => {
    const dir = tempObsDir();
    const main = writeParentTranscript(dir);
    seedState(dir, "agg2", main);

    runHook(
      "stop.mjs",
      { session_id: "agg2", transcript_path: main, hook_event_name: "Stop", last_assistant_message: "done" },
      dir,
    );

    // 普通工具的 tool_result 没有 toolUseResult.agentId，不该凭空长出 agent 标
    for (const s of readSpans(dir).filter((s) => s.kind === "tool" && s.name !== "Agent")) {
      expect(s.tags.agent_id).toBeUndefined();
      expect(s.tags.agent_total_tokens).toBeUndefined();
    }
  });
});

// —— span_id 幂等派生（2026-08-12）——
// 症状：控制台每条 llm / tool 都显示两遍。实测根因是同一个 Stop 事件被注册了两遍
// （用户 settings.json 手工注册 + 已启用 plugin 各一份），两个 hook 进程并行跑、
// 读到同一份还没推进的 state.cursor，于是同一批 transcript 行被各合成一遍。
// llm/tool span 原先用 crypto.randomBytes 当 span_id，两份成了不同键，
// ReplacingMergeTree 按 (trace_id, ts, span_id) 折不掉 → 全部翻倍。
// 反证：root / 子代理 agent span / 带 agentId 的 Agent tool span 本来就用派生 id，
// 实测那几条恰好一条没重复。
describe("同一批 transcript 行重复合成必须幂等", () => {
  /** 两条 llm 回合 + 本地/MCP 工具各一，带 uuid（真实 transcript 每行都有）。 */
  function idempotencyTranscript(dir) {
    return writeTranscript(dir, "idem.jsonl", [
      { type: "user", uuid: "u-0", timestamp: T("00.000"), message: { role: "user", content: "诊断: 为什么卡住" } },
      {
        type: "assistant",
        uuid: "u-1",
        timestamp: T("05.000"),
        message: {
          model: "claude-fable-5",
          usage: { input_tokens: 3, output_tokens: 50 },
          content: [
            { type: "text", text: "先看进程" },
            { type: "tool_use", id: "tu_local", name: "Bash", input: { command: "ls" } },
            { type: "tool_use", id: "tu_mcp", name: "mcp__dbdog__search_dbdog_logs", input: { query: "x" } },
          ],
        },
      },
      {
        type: "user",
        uuid: "u-2",
        timestamp: T("07.500"),
        message: {
          role: "user",
          content: [
            { type: "tool_result", tool_use_id: "tu_local", content: "file1" },
            { type: "tool_result", tool_use_id: "tu_mcp", content: "log line" },
          ],
        },
      },
      {
        type: "assistant",
        uuid: "u-3",
        timestamp: T("20.000"),
        message: { model: "claude-fable-5", usage: { input_tokens: 2, output_tokens: 80 }, content: [{ type: "text", text: "结论如下" }] },
      },
    ]);
  }

  it("并行的第二个 Stop 进程（同一 cursor）产出同键同 ts 的 span，读侧可折叠", () => {
    const dir = tempObsDir();
    const transcript = idempotencyTranscript(dir);
    seedState(dir, "idem", transcript);
    const statePath = path.join(dir, "idem.json");
    const staleState = fs.readFileSync(statePath, "utf8"); // 第二个进程读到的那份
    const input = {
      session_id: "idem",
      transcript_path: transcript,
      hook_event_name: "Stop",
      last_assistant_message: "结论如下",
    };

    runHook("stop.mjs", input, dir);
    const first = readSpans(dir);
    expect(first.filter((s) => s.kind === "llm")).toHaveLength(2);
    expect(first.filter((s) => s.kind === "tool")).toHaveLength(2);

    // 并行第二份：state 还没被推进，读到的 cursor 与第一份相同
    fs.writeFileSync(statePath, staleState);
    runHook("stop.mjs", input, dir);
    const all = readSpans(dir);
    const second = all.slice(first.length);
    expect(second).toHaveLength(first.length); // 确实又合成了一整批

    // 关键：两批逐条同键。ts 也必须一致——它同在 ClickHouse 排序键里，
    // 只对上 span_id、ts 漂了照样折不掉。
    const keyOf = (s) => `${s.span_id}|${s.ts}`;
    expect(new Set(all.map(keyOf)).size).toBe(new Set(first.map(keyOf)).size);
    expect(new Set(second.map(keyOf))).toEqual(new Set(first.map(keyOf)));
  });

  it("span_id 由 tool_use_id / entry uuid 派生，同 trace 内不撞键", () => {
    const dir = tempObsDir();
    const transcript = idempotencyTranscript(dir);
    seedState(dir, "derive", transcript);
    runHook(
      "stop.mjs",
      { session_id: "derive", transcript_path: transcript, hook_event_name: "Stop", last_assistant_message: "done" },
      dir,
    );

    const spans = readSpans(dir);
    expect(new Set(spans.map((s) => s.span_id)).size).toBe(spans.length);
    for (const s of spans) expect(s.span_id).toMatch(/^[0-9a-f]{16}$/);

    const traceId = "a".repeat(32);
    const derive = (key) =>
      crypto.createHash("sha256").update(`${traceId}:${key}`).digest("hex").slice(0, 16);
    expect(spans.find((s) => s.name === "Bash").span_id).toBe(derive("tool_use:tu_local"));
    expect(spans.find((s) => s.name === "search_dbdog_logs").span_id).toBe(derive("tool_use:tu_mcp"));
    const llm = spans.filter((s) => s.kind === "llm");
    expect(llm.map((s) => s.span_id)).toEqual([derive("llm:u-1"), derive("llm:u-3")]);
  });
});

// —— trace 交界处的尾巴不能丢（2026-08-12）——
// 实测：一条 trace 恒定丢最后一轮的 llm span。Stop 读 transcript 时，本轮收尾那几行
// （通常就是产出结论的 assistant 行）往往还没落盘；而下一条 trace 铸造时游标会跳到文件
// 当前末尾（cursor = statSync(size)），那几行就永久没人合成。
// 字节级证据：cursor=8292 / 文件 10906，8292–10672 那两行带完整 usage 的 assistant 未被读。
// 修法：铸造/停用时把 [旧 cursor, 交界时文件大小) 这段连同配对上下文记进 state.carry，
// 下一次 Stop 按**旧** trace_id 补合成。上界取自交界时刻，所以不会把新一轮内容错记到旧 trace。
describe("trace 交界处未落盘的尾巴要按旧 trace 补上", () => {
  /** 只写用户那一行；带 usage 的 assistant 行留到"铸造之后"再追加，模拟落盘滞后。 */
  function seedFirstTurn(dir, name) {
    const p = writeTranscript(dir, name, [
      { type: "user", uuid: "u-a", timestamp: T("00.000"), message: { role: "user", content: "诊断: 第一问" } },
    ]);
    return p;
  }
  const lateAssistant = {
    type: "assistant",
    uuid: "u-late",
    timestamp: T("30.000"),
    message: {
      model: "claude-fable-5",
      usage: { input_tokens: 100, output_tokens: 900 },
      content: [{ type: "text", text: "## 诊断报告\n根因是 vacuum_cost_delay。" }],
    },
  };

  it("下一条 trace 铸造时记下 carry，Stop 按旧 trace_id 补出 llm span", () => {
    const dir = tempObsDir();
    const tr = seedFirstTurn(dir, "boundary.jsonl");

    runHook("user-prompt-submit.mjs", { session_id: "b1", prompt: "诊断: 第一问", cwd: "/tmp/proj", transcript_path: tr }, dir);
    const first = readState(dir, "b1");
    runHook("stop.mjs", { session_id: "b1", transcript_path: tr, hook_event_name: "Stop", last_assistant_message: "报告" }, dir);

    // ← 收尾那行此刻才落盘（真实里 Stop 已经读过一遍了）
    fs.appendFileSync(tr, JSON.stringify(lateAssistant) + "\n");

    runHook("user-prompt-submit.mjs", { session_id: "b1", prompt: "诊断: 第二问", cwd: "/tmp/proj", transcript_path: tr }, dir);
    const second = readState(dir, "b1");
    expect(second.trace_id).not.toBe(first.trace_id); // 确实铸了新 trace
    expect(second.carry?.trace_id).toBe(first.trace_id);
    expect(second.carry?.root_span_id).toBe(first.root_span_id);

    runHook("stop.mjs", { session_id: "b1", transcript_path: tr, hook_event_name: "Stop", last_assistant_message: "第二问回答" }, dir);

    const llmOfFirst = readSpans(dir).filter((s) => s.kind === "llm" && s.trace_id === first.trace_id);
    expect(llmOfFirst).toHaveLength(1);
    expect(llmOfFirst[0].parent_id).toBe(first.root_span_id); // 挂在旧 trace 的 root 下
    expect(llmOfFirst[0].tokens_output).toBe(900);
    expect(readState(dir, "b1").carry).toBeUndefined(); // 收完即清，不重复
  });

  it("换话题（不带触发词）同样收尾——trace 已 inactive 也要补", () => {
    const dir = tempObsDir();
    const tr = seedFirstTurn(dir, "boundary2.jsonl");

    runHook("user-prompt-submit.mjs", { session_id: "b2", prompt: "诊断: 第一问", cwd: "/tmp/proj", transcript_path: tr }, dir);
    const first = readState(dir, "b2");
    runHook("stop.mjs", { session_id: "b2", transcript_path: tr, hook_event_name: "Stop", last_assistant_message: "报告" }, dir);
    fs.appendFileSync(tr, JSON.stringify(lateAssistant) + "\n");

    runHook("user-prompt-submit.mjs", { session_id: "b2", prompt: "顺便说下天气", cwd: "/tmp/proj", transcript_path: tr }, dir);
    const off = readState(dir, "b2");
    expect(off.active).toBe(false);
    expect(off.carry?.trace_id).toBe(first.trace_id);

    runHook("stop.mjs", { session_id: "b2", transcript_path: tr, hook_event_name: "Stop", last_assistant_message: "今天晴" }, dir);

    const spans = readSpans(dir).filter((s) => s.trace_id === first.trace_id);
    expect(spans.filter((s) => s.kind === "llm")).toHaveLength(1);
    // 停用状态不得顺手再产 root span / 不得把新话题算进旧 trace
    expect(spans.filter((s) => s.kind === "agent")).toHaveLength(1);
    expect(readState(dir, "b2").carry).toBeUndefined();
  });

  it("交界时没有未读尾巴 → 不写 carry（不留空壳）", () => {
    const dir = tempObsDir();
    const tr = seedFirstTurn(dir, "boundary3.jsonl");
    runHook("user-prompt-submit.mjs", { session_id: "b3", prompt: "诊断: 第一问", cwd: "/tmp/proj", transcript_path: tr }, dir);
    runHook("stop.mjs", { session_id: "b3", transcript_path: tr, hook_event_name: "Stop", last_assistant_message: "报告" }, dir);
    // 不追加任何内容：游标已到文件末尾
    runHook("user-prompt-submit.mjs", { session_id: "b3", prompt: "诊断: 第二问", cwd: "/tmp/proj", transcript_path: tr }, dir);
    expect(readState(dir, "b3").carry).toBeUndefined();
  });
});

// —— 总结 span 的 ts 必须稳定（2026-08-12）——
// 症状（尚未咬到线上，因总结那条链缺凭证）：总结会在每个"有新工具调用"的 Stop 之后重算，
// span_id 是派生的（固定），但 ts 取 new Date() —— 墙上时钟。而 ClickHouse 那张表排序键是
// (trace_id, ts, span_id)，ts 一变就是新行、FINAL 折不掉，于是平台上堆好几条总结；
// 控制台 findSummarySpan 用 .find() 按 ts 序取，拿到的是最早那条 = 过期总结。
// 与 span_id 幂等派生同一类错：只对上 span_id 没用，ts 也在排序键里。
describe("总结 span 重复生成必须落同一行", () => {
  /** Anthropic Messages 协议的桩端点。 */
  async function startLlmStub() {
    const server = http.createServer((req, res) => {
      req.on("data", () => {});
      req.on("end", () => {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(
          JSON.stringify({
            content: [{ type: "text", text: "## 诊断流程总结\n桩返回的正文。" }],
            usage: { input_tokens: 11, output_tokens: 22 },
          }),
        );
      });
    });
    await new Promise((r) => server.listen(0, "127.0.0.1", r));
    return {
      baseUrl: `http://127.0.0.1:${server.address().port}`,
      close: () => new Promise((r) => server.close(r)),
    };
  }

  /** worker 的 sessionId 走 argv，不是 stdin，所以不能用 runScript。 */
  function runWorker(dir, sessionId, extraEnv) {
    return new Promise((resolve, reject) => {
      const child = spawn(process.execPath, [path.join(HOOK_DIR, "summary-worker.mjs"), sessionId], {
        env: {
          ...process.env,
          DBDOG_OBS_DIR: dir,
          DBDOG_OBS_SPANS: path.join(dir, "spans.jsonl"),
          DBDOG_OBS_REPORT_URL: "",
          DBDOG_OBS_API_KEY: "",
          ...extraEnv,
        },
      });
      let stderr = "";
      child.stderr.on("data", (d) => (stderr += d));
      child.on("error", reject);
      child.on("close", (code) => {
        expect(code, stderr).toBe(0);
        resolve(stderr);
      });
    });
  }

  it("重算两次 → span_id 与 ts 都不变，且 ts 锚在 trace 起点", async () => {
    const dir = tempObsDir();
    const llm = await startLlmStub();
    const traceId = "c".repeat(32);
    const startedAt = "2026-07-15T00:00:00.000Z";
    writeStateFile(dir, "sum.json", {
      active: true,
      trace_id: traceId,
      root_span_id: traceId.slice(0, 16),
      session_id: "sum",
      ml_app: "testapp",
      started_at: startedAt,
    });
    // worker 要求本 trace 至少有一条 span（真相源 = spans.jsonl）
    fs.writeFileSync(
      path.join(dir, "spans.jsonl"),
      JSON.stringify({
        trace_id: traceId,
        span_id: traceId.slice(0, 16),
        kind: "agent",
        name: "claude-code.task",
        ts: "2026-07-15T00:00:01.000Z",
        output: "诊断结论：根因是 vacuum_cost_delay。",
      }) + "\n",
    );

    const env = { DBDOG_SUMMARY_LLM_BASE_URL: llm.baseUrl, DBDOG_SUMMARY_LLM_API_KEY: "stub-key-123" };
    try {
      await runWorker(dir, "sum", env);
      await runWorker(dir, "sum", env); // 第二轮重算（真实里由下一次 Stop 触发）
    } finally {
      await llm.close();
    }

    const sums = readSpans(dir).filter((s) => s.kind === "workflow" && s.name === "diagnosis-summary");
    expect(sums).toHaveLength(2); // 本地 JSONL 追加两行是正常的
    // 关键：两行必须同键同 ts，读侧（ClickHouse FINAL / byId 去重）才折得成一条
    expect(new Set(sums.map((s) => s.span_id)).size).toBe(1);
    expect(new Set(sums.map((s) => s.ts)).size).toBe(1);
    expect(sums[0].ts).toBe(startedAt); // 锚在 trace 起点：总结描述的就是整条 trace
  });
});

// —— 上报超时可配（2026-08-10）——
// 默认 3000 按「直连 mcp」定；透明代理/隧道后的机器首字节 1–4s 抖动会一直 abort，
// 症状是 spans.jsonl 有、平台空，且 pending 越滚越大。
describe("上报超时可配", () => {
  const original = process.env.DBDOG_OBS_REPORT_TIMEOUT_MS;
  afterEach(() => {
    if (original === undefined) delete process.env.DBDOG_OBS_REPORT_TIMEOUT_MS;
    else process.env.DBDOG_OBS_REPORT_TIMEOUT_MS = original;
  });

  it("缺省 3000，正数覆盖，非法值退回缺省", async () => {
    const { reportTimeoutMs } = await import("./lib.mjs");
    delete process.env.DBDOG_OBS_REPORT_TIMEOUT_MS;
    expect(reportTimeoutMs()).toBe(3000);
    process.env.DBDOG_OBS_REPORT_TIMEOUT_MS = "15000";
    expect(reportTimeoutMs()).toBe(15000);
    for (const bad of ["", "abc", "0", "-1"]) {
      process.env.DBDOG_OBS_REPORT_TIMEOUT_MS = bad;
      expect(reportTimeoutMs()).toBe(3000);
    }
  });
});

// —— 会话直接结束（claude -p / 关窗）的尾巴（2026-08-14）——
// carry 机制只在「下一次 UserPromptSubmit」铸造时记账；一次性会话没有下一次，
// Stop 读 transcript 时结论行还没落盘 → [cursor, EOF] 永久没人合成。
// 47 圈 headless 巡检实测：46/47 圈丢尾部 llm span（正是结论轮）；更狠的是
// 会话退出时仍在跑的子代理连 SubagentStop 都没有，整棵子树消失（一圈丢 241 条）。
// 根治：SessionEnd hook 收尾——主线补 [cursor, EOF]，子代理 transcript 挨个补到 EOF。
describe("SessionEnd 收尾：会话直接结束不丢尾", () => {
  const lateFinal = {
    type: "assistant",
    uuid: "u-final",
    timestamp: T("30.000"),
    message: {
      model: "claude-fable-5",
      usage: { input_tokens: 100, output_tokens: 900 },
      content: [{ type: "text", text: "## 诊断报告\n根因是 vacuum_cost_delay。" }],
    },
  };

  it("Stop 之后才落盘的结论行，SessionEnd 按本 trace 补出 llm span", () => {
    const dir = tempObsDir();
    const tr = writeTranscript(dir, "se1.jsonl", [
      { type: "user", uuid: "u-q", timestamp: T("00.000"), message: { role: "user", content: "诊断: 第一问" } },
    ]);
    runHook("user-prompt-submit.mjs", { session_id: "se1", prompt: "诊断: 第一问", cwd: "/tmp/proj", transcript_path: tr }, dir);
    const st = readState(dir, "se1");
    runHook("stop.mjs", { session_id: "se1", transcript_path: tr, hook_event_name: "Stop", last_assistant_message: "报告" }, dir);
    // ← 结论行此刻才落盘；一次性会话再没有下一轮 UserPromptSubmit/Stop
    fs.appendFileSync(tr, JSON.stringify(lateFinal) + "\n");

    runHook("session-end.mjs", { session_id: "se1", transcript_path: tr, hook_event_name: "SessionEnd", reason: "exit" }, dir);

    const llm = readSpans(dir).filter((s) => s.kind === "llm" && s.trace_id === st.trace_id);
    expect(llm).toHaveLength(1);
    expect(llm[0].parent_id).toBe(st.root_span_id);
    expect(llm[0].tokens_output).toBe(900);
    expect(readState(dir, "se1").cursor).toBe(fs.statSync(tr).size); // 游标推到 EOF
  });

  it("会话退出时仍在跑的子代理：SessionEnd 把整棵子树补出来", () => {
    const dir = tempObsDir();
    const tr = writeTranscript(dir, "se2.jsonl", [
      { type: "user", uuid: "u-q", timestamp: T("00.000"), message: { role: "user", content: "诊断: 并发问题" } },
    ]);
    runHook("user-prompt-submit.mjs", { session_id: "se2", prompt: "诊断: 并发问题", cwd: "/tmp/proj", transcript_path: tr }, dir);
    const st = readState(dir, "se2");
    runHook("stop.mjs", { session_id: "se2", transcript_path: tr, hook_event_name: "Stop", last_assistant_message: "派了个子代理" }, dir);

    // 子代理 transcript 存在、但从没有 SubagentStop（会话退出时它还在跑）
    const subDir = path.join(dir, "se2", "subagents");
    fs.mkdirSync(subDir, { recursive: true });
    const agentId = "adeadbeef12345678";
    fs.writeFileSync(
      path.join(subDir, `agent-${agentId}.meta.json`),
      JSON.stringify({ agentType: "general-purpose", toolUseId: "tu_x", spawnDepth: 1 }),
    );
    fs.writeFileSync(
      path.join(subDir, `agent-${agentId}.jsonl`),
      [
        { type: "user", uuid: "s-u", timestamp: T("10.000"), message: { role: "user", content: "查锁等待" } },
        {
          type: "assistant",
          uuid: "s-a1",
          timestamp: T("12.000"),
          message: {
            model: "claude-fable-5",
            usage: { input_tokens: 10, output_tokens: 20 },
            content: [
              { type: "text", text: "先查 pg_locks" },
              { type: "tool_use", id: "s_tu1", name: "Bash", input: { command: "gsql -c 'select 1'" } },
            ],
          },
        },
        {
          type: "user",
          uuid: "s-u2",
          timestamp: T("13.000"),
          message: { role: "user", content: [{ type: "tool_result", tool_use_id: "s_tu1", content: "1" }] },
        },
      ]
        .map((e) => JSON.stringify(e))
        .join("\n") + "\n",
    );

    runHook("session-end.mjs", { session_id: "se2", transcript_path: tr, hook_event_name: "SessionEnd", reason: "exit" }, dir);

    const spans = readSpans(dir).filter((s) => s.trace_id === st.trace_id);
    const agentSpan = spans.find((s) => s.kind === "agent" && s.name === "claude-code.subagent");
    expect(agentSpan).toBeTruthy();
    expect(agentSpan.tags.agent_id).toBe(agentId);
    expect(agentSpan.tags.agent_type).toBe("general-purpose");
    const subLlm = spans.filter((s) => s.kind === "llm" && s.tags.agent_id === agentId);
    const subTool = spans.filter((s) => s.kind === "tool" && s.tags.agent_id === agentId);
    expect(subLlm).toHaveLength(1);
    expect(subTool).toHaveLength(1);
    expect(subLlm[0].parent_id).toBe(agentSpan.span_id); // 挂在子代理自己的 agent span 下
  });

  it("SessionEnd 重入幂等：第二次跑不再产新 span", () => {
    const dir = tempObsDir();
    const tr = writeTranscript(dir, "se3.jsonl", [
      { type: "user", uuid: "u-q", timestamp: T("00.000"), message: { role: "user", content: "诊断: 第一问" } },
    ]);
    runHook("user-prompt-submit.mjs", { session_id: "se3", prompt: "诊断: 第一问", cwd: "/tmp/proj", transcript_path: tr }, dir);
    runHook("stop.mjs", { session_id: "se3", transcript_path: tr, hook_event_name: "Stop", last_assistant_message: "报告" }, dir);
    fs.appendFileSync(tr, JSON.stringify(lateFinal) + "\n");
    runHook("session-end.mjs", { session_id: "se3", transcript_path: tr, hook_event_name: "SessionEnd", reason: "exit" }, dir);
    const n = readSpans(dir).length;
    runHook("session-end.mjs", { session_id: "se3", transcript_path: tr, hook_event_name: "SessionEnd", reason: "exit" }, dir);
    expect(readSpans(dir)).toHaveLength(n);
  });

  it("trace 已停用（换过话题）只收 carry，不把停用后的行算进旧 trace", () => {
    const dir = tempObsDir();
    const tr = writeTranscript(dir, "se4.jsonl", [
      { type: "user", uuid: "u-q", timestamp: T("00.000"), message: { role: "user", content: "诊断: 第一问" } },
    ]);
    runHook("user-prompt-submit.mjs", { session_id: "se4", prompt: "诊断: 第一问", cwd: "/tmp/proj", transcript_path: tr }, dir);
    const first = readState(dir, "se4");
    runHook("stop.mjs", { session_id: "se4", transcript_path: tr, hook_event_name: "Stop", last_assistant_message: "报告" }, dir);
    fs.appendFileSync(tr, JSON.stringify(lateFinal) + "\n"); // 旧 trace 的尾巴
    runHook("user-prompt-submit.mjs", { session_id: "se4", prompt: "顺便聊聊天气", cwd: "/tmp/proj", transcript_path: tr }, dir);
    // 停用后的闲聊行:不属于任何 trace
    fs.appendFileSync(
      tr,
      JSON.stringify({
        type: "assistant",
        uuid: "u-chat",
        timestamp: T("40.000"),
        message: { model: "m", usage: { input_tokens: 1, output_tokens: 2 }, content: [{ type: "text", text: "晴" }] },
      }) + "\n",
    );

    runHook("session-end.mjs", { session_id: "se4", transcript_path: tr, hook_event_name: "SessionEnd", reason: "exit" }, dir);

    const ofTrace = readSpans(dir).filter((s) => s.trace_id === first.trace_id && s.kind === "llm");
    expect(ofTrace).toHaveLength(1); // carry 区间里的结论行补上了
    expect(ofTrace[0].tokens_output).toBe(900); // 且只是它——停用后的闲聊没被算进来
  });
});

// —— 总结失败要留痕 + SessionEnd 触发总结（2026-08-14）——
// 45/47 圈无总结的教训：worker detached + stdio ignore + run() 吞错 = 死了没人知道。
// ① 失败在 obsDir/summary-worker.log 落一行（时间戳 + session + 错误）；
// ② 一次性会话的总结改由 SessionEnd 收尾后触发——此时尾部结论 span 已补齐，
//    总结吃到的是完整 trace（Stop 时刻的 spawn 保持不动，读侧同键后写赢）。
describe("总结失败留痕 + SessionEnd 触发总结", () => {
  function startStub(payload, status = 200) {
    const bodies = [];
    const server = http.createServer((req, res) => {
      let body = "";
      req.on("data", (d) => (body += d));
      req.on("end", () => {
        try { bodies.push(JSON.parse(body)); } catch {}
        res.writeHead(status, { "content-type": "application/json" });
        res.end(JSON.stringify(payload));
      });
    });
    return new Promise((r) =>
      server.listen(0, "127.0.0.1", () =>
        r({ baseUrl: `http://127.0.0.1:${server.address().port}`, bodies, close: () => new Promise((c) => server.close(c)) }),
      ),
    );
  }
  function runWorker(dir, sessionId, extraEnv) {
    return new Promise((resolve, reject) => {
      const child = spawn(process.execPath, [path.join(HOOK_DIR, "summary-worker.mjs"), sessionId], {
        env: {
          ...process.env,
          DBDOG_OBS_DIR: dir,
          DBDOG_OBS_SPANS: path.join(dir, "spans.jsonl"),
          DBDOG_OBS_REPORT_URL: "",
          DBDOG_OBS_API_KEY: "",
          ...extraEnv,
        },
      });
      child.on("error", reject);
      child.on("close", (code) => resolve(code));
    });
  }
  const waitFor = async (pred, ms = 4000) => {
    const t0 = Date.now();
    while (Date.now() - t0 < ms) {
      if (pred()) return true;
      await new Promise((r) => setTimeout(r, 100));
    }
    return pred();
  };

  it("worker 失败 → summary-worker.log 留一行可诊断痕迹（exit 仍 0）", async () => {
    const dir = tempObsDir();
    // 推理模型典型故障:200 + thinking-only + stop_reason=max_tokens
    const llm = await startStub({ stop_reason: "max_tokens", content: [{ type: "thinking", thinking: "…" }] });
    const traceId = "d".repeat(32);
    fs.writeFileSync(
      path.join(dir, "wl.json"),
      JSON.stringify({ active: true, trace_id: traceId, root_span_id: traceId.slice(0, 16), session_id: "wl", started_at: "2026-07-15T00:00:00.000Z" }),
    );
    fs.writeFileSync(
      path.join(dir, "spans.jsonl"),
      JSON.stringify({ trace_id: traceId, span_id: traceId.slice(0, 16), kind: "agent", ts: "2026-07-15T00:00:01.000Z", output: "结论" }) + "\n",
    );
    try {
      const code = await runWorker(dir, "wl", {
        DBDOG_SUMMARY_LLM_BASE_URL: llm.baseUrl,
        DBDOG_SUMMARY_LLM_API_KEY: "stub-key",
      });
      expect(code).toBe(0);
    } finally {
      await llm.close();
    }
    const logPath = path.join(dir, "summary-worker.log");
    expect(fs.existsSync(logPath)).toBe(true);
    const line = fs.readFileSync(logPath, "utf8");
    expect(line).toContain("wl"); // sessionId
    expect(line).toMatch(/max_tokens/); // 错误里说清了截停原因
  });

  it("SessionEnd 收尾后触发总结:一次性会话也能出 workflow span(吃到补齐后的完整 trace)", async () => {
    const dir = tempObsDir();
    const llm = await startStub({ content: [{ type: "text", text: "SessionEnd 之后的总结。" }], usage: {} });
    const tr = writeTranscript(dir, "se-sum.jsonl", [
      { type: "user", uuid: "u-q", timestamp: T("00.000"), message: { role: "user", content: "诊断: 为什么慢" } },
    ]);
    const summaryEnvVars = {
      DBDOG_SUMMARY_LLM_BASE_URL: llm.baseUrl,
      DBDOG_SUMMARY_LLM_API_KEY: "stub-key",
    };
    runHook("user-prompt-submit.mjs", { session_id: "se-sum", prompt: "诊断: 为什么慢", cwd: "/tmp/proj", transcript_path: tr }, dir);
    const st = readState(dir, "se-sum");
    // Stop 时总结 env 故意不配——隔离出「SessionEnd 也要触发」这条路径
    runHook("stop.mjs", { session_id: "se-sum", transcript_path: tr, hook_event_name: "Stop", last_assistant_message: "……" }, dir);
    // 结论行 + 工具轮在 Stop 之后才落盘(一次性会话典型时序)
    fs.appendFileSync(
      tr,
      [
        {
          type: "assistant", uuid: "u-tail-tool", timestamp: T("20.000"),
          message: { model: "m", usage: { input_tokens: 5, output_tokens: 6 }, content: [
            { type: "text", text: "查一下" },
            { type: "tool_use", id: "tu_tail", name: "Bash", input: { command: "ls" } },
          ] },
        },
        { type: "user", uuid: "u-tail-res", timestamp: T("21.000"), message: { role: "user", content: [{ type: "tool_result", tool_use_id: "tu_tail", content: "ok" }] } },
        {
          type: "assistant", uuid: "u-tail-fin", timestamp: T("22.000"),
          message: { model: "m", usage: { input_tokens: 7, output_tokens: 8 }, content: [{ type: "text", text: "根因在 X。" }] },
        },
      ].map((e) => JSON.stringify(e)).join("\n") + "\n",
    );
    try {
      runHook(
        "session-end.mjs",
        { session_id: "se-sum", transcript_path: tr, hook_event_name: "SessionEnd", reason: "exit" },
        dir,
        summaryEnvVars,
      );
      const ok = await waitFor(() =>
        fs.existsSync(path.join(dir, "spans.jsonl")) &&
        readSpans(dir).some((s) => s.kind === "workflow" && s.name === "diagnosis-summary" && s.trace_id === st.trace_id),
      );
      expect(ok, "SessionEnd 后 4s 内应出 workflow 总结 span").toBe(true);
    } finally {
      await llm.close();
    }
    const sum = readSpans(dir).find((s) => s.kind === "workflow");
    expect(sum.output).toBe("SessionEnd 之后的总结。");
    expect(sum.ts).toBe(st.started_at ?? sum.ts); // ts 锚在 trace 起点(既有约定)
    // codex 复审反例:光出 workflow span 不够——重算的意义是事实表里有尾部结论。
    // trimSpans 只读 agent/tool 证据,所以尾部结论必须先进 root output(SessionEnd 刷新)。
    const factBodies = JSON.stringify(llm.bodies);
    expect(factBodies, "发给模型的事实表必须包含尾部结论").toContain("根因在 X");
  });
});

// —— sweep 排空短板（2026-08-14，owner 拍板最小修）——
// 47 圈巡检实测:3 个积压文件(213/141/24 条)横跨 30+ 个 SessionStart 反复补发不动——
// 200 条/批 × 全文 span(input/output 各 8K 字符封顶,最坏 ~3.2MB)骑在 3s 缺省上报
// 超时上,一批超时→整体留着→下次原样再撞。三点最小修:批量 50、sweep 侧缺省超时 10s、
// SessionEnd 收尾末尾也排空一次(一串 headless 会话结束后再无 SessionStart,旧积压
// 从此没人管——正是 B 类送达丢失卡死的触发链)。
describe("sweep 排空短板:批量 50 + 超时 10s + SessionEnd 触发", () => {
  it("缺省批量 50:120 条积压分 3 批发完", async () => {
    const dir = tempObsDir();
    const sink = await startSpanSink();
    try {
      const ids = Array.from({ length: 120 }, (_, i) => `sp${i}`);
      fs.writeFileSync(
        path.join(dir, "spans.jsonl"),
        ids.map((id) => JSON.stringify({ trace_id: "t", span_id: id, kind: "llm", name: id })).join("\n") + "\n",
      );
      const p = writeStateFile(dir, "big50.json", { trace_id: "t", pending_spans: ids });
      ageFile(p, 3 * HOUR);

      await runScript("sweep.mjs", dir, {
        DBDOG_OBS_REPORT_URL: sink.url,
        DBDOG_OBS_API_KEY: "k",
        DBDOG_OBS_SWEEP_IDLE_MS: String(HOUR),
        // 显式置空:宿主 shell 若真配着这些 env,继承下来会假绿(codex 审查项)
        DBDOG_OBS_SWEEP_BATCH: "",
        DBDOG_OBS_REPORT_TIMEOUT_MS: "",
      });

      expect(sink.received).toHaveLength(120);
      expect(sink.batches).toEqual([50, 50, 20]);
      expect(JSON.parse(fs.readFileSync(p, "utf8")).pending_spans).toEqual([]);
    } finally {
      await sink.close();
    }
  });

  it("sweep 缺省上报超时放宽:慢 sink(首字节 4s,超旧 3s 缺省)也能排空", async () => {
    const dir = tempObsDir();
    // 首字节压 4 秒的 sink:旧缺省 3s 必 abort,pending 永远排不空(实测症状同款)
    const received = [];
    const server = http.createServer((req, res) => {
      let body = "";
      req.on("data", (d) => (body += d));
      req.on("end", () => {
        setTimeout(() => {
          try { received.push(...JSON.parse(body).spans); } catch {}
          res.writeHead(202, { "content-type": "application/json" });
          res.end("{}");
        }, 4000);
      });
    });
    await new Promise((r) => server.listen(0, "127.0.0.1", r));
    const url = `http://127.0.0.1:${server.address().port}/api/v2/llmobs/spans`;
    try {
      fs.writeFileSync(
        path.join(dir, "spans.jsonl"),
        JSON.stringify({ trace_id: "t1", span_id: "slow1", kind: "llm", name: "x" }) + "\n",
      );
      const p = writeStateFile(dir, "slow.json", { trace_id: "t1", pending_spans: ["slow1"] });
      ageFile(p, 3 * HOUR);

      await runScript("sweep.mjs", dir, {
        DBDOG_OBS_REPORT_URL: url,
        DBDOG_OBS_API_KEY: "k",
        DBDOG_OBS_SWEEP_IDLE_MS: String(HOUR),
        // 显式置空:测的就是 sweep 侧缺省;宿主 env 继承会假绿(codex 审查项)
        DBDOG_OBS_SWEEP_BATCH: "",
        DBDOG_OBS_REPORT_TIMEOUT_MS: "",
      });

      expect(received.map((s) => s.span_id)).toEqual(["slow1"]);
      expect(JSON.parse(fs.readFileSync(p, "utf8")).pending_spans).toEqual([]);
    } finally {
      await new Promise((r) => server.close(r));
    }
  }, 15_000);

  it("SessionEnd 收尾流程末尾触发一次排空:旧会话的积压被补发", async () => {
    const dir = tempObsDir();
    const sink = await startSpanSink();
    try {
      // 旧会话:pending 卡死、状态文件早已 idle
      fs.writeFileSync(
        path.join(dir, "spans.jsonl"),
        JSON.stringify({ trace_id: "told", span_id: "stuck1", kind: "llm", name: "x" }) + "\n",
      );
      const pOld = writeStateFile(dir, "old.json", { trace_id: "told", pending_spans: ["stuck1"] });
      ageFile(pOld, 3 * HOUR);

      // 当前会话:正常收尾(无尾巴可补,纯触发 sweep)
      const tr = writeTranscript(dir, "cur.jsonl", [
        { type: "user", uuid: "u", timestamp: T("00.000"), message: { role: "user", content: "诊断: q" } },
      ]);
      writeStateFile(dir, "cur.json", {
        active: true,
        trace_id: "e".repeat(32),
        root_span_id: "e".repeat(16),
        session_id: "cur",
        transcript_path: tr,
        cursor: fs.statSync(tr).size, // 游标已在 EOF → 本会话自己无span 可补
        started_at: "2026-07-15T00:00:00.000Z",
        root_emitted: true, // 正常 Stop 过的会话,root 已落——SessionEnd 不再补
      });

      runHook(
        "session-end.mjs",
        { session_id: "cur", transcript_path: tr, hook_event_name: "SessionEnd", reason: "exit" },
        dir,
        {
          DBDOG_OBS_REPORT_URL: sink.url,
          DBDOG_OBS_API_KEY: "k",
          DBDOG_OBS_SWEEP_IDLE_MS: String(HOUR),
        },
      );

      // sweep 是 detached 后台进程,轮询等它排空(容忍与 writeFileSync 撞车的瞬时读损)
      const t0 = Date.now();
      let drained = false;
      while (Date.now() - t0 < 8000 && !drained) {
        try {
          drained = JSON.parse(fs.readFileSync(pOld, "utf8")).pending_spans?.length === 0;
        } catch {
          /* 撞上非原子写,当没排空继续等 */
        }
        if (!drained) await new Promise((r) => setTimeout(r, 100));
      }
      expect(drained, "SessionEnd 后 8s 内旧积压应被排空").toBe(true);
      expect(sink.received.map((s) => s.span_id)).toEqual(["stuck1"]);
    } finally {
      await sink.close();
    }
  }, 15_000);

  it("无 trace 状态的会话,SessionEnd 也触发排空(sweep 与本会话有无 trace 无关)", async () => {
    const dir = tempObsDir();
    const sink = await startSpanSink();
    try {
      fs.writeFileSync(
        path.join(dir, "spans.jsonl"),
        JSON.stringify({ trace_id: "told2", span_id: "stuck2", kind: "llm", name: "x" }) + "\n",
      );
      const pOld = writeStateFile(dir, "old2.json", { trace_id: "told2", pending_spans: ["stuck2"] });
      ageFile(pOld, 3 * HOUR);
      // 当前会话从未触发观测:没有状态文件
      runHook(
        "session-end.mjs",
        { session_id: "no-state", transcript_path: path.join(dir, "none.jsonl"), hook_event_name: "SessionEnd", reason: "exit" },
        dir,
        { DBDOG_OBS_REPORT_URL: sink.url, DBDOG_OBS_API_KEY: "k", DBDOG_OBS_SWEEP_IDLE_MS: String(HOUR) },
      );
      const t0 = Date.now();
      let drained = false;
      while (Date.now() - t0 < 8000 && !drained) {
        try {
          drained = JSON.parse(fs.readFileSync(pOld, "utf8")).pending_spans?.length === 0;
        } catch {}
        if (!drained) await new Promise((r) => setTimeout(r, 100));
      }
      expect(drained, "无状态会话的 SessionEnd 也要排空旧积压").toBe(true);
    } finally {
      await sink.close();
    }
  }, 15_000);

  it("显式配置的上报超时不被 sweep 的 10s 缺省覆盖", async () => {
    const dir = tempObsDir();
    // 首字节压 2s 的 sink;显式配 500ms 超时 → 必须失败、pending 保留
    const server = http.createServer((req, res) => {
      req.on("data", () => {});
      req.on("end", () => setTimeout(() => { res.writeHead(202); res.end("{}"); }, 2000));
    });
    await new Promise((r) => server.listen(0, "127.0.0.1", r));
    try {
      fs.writeFileSync(
        path.join(dir, "spans.jsonl"),
        JSON.stringify({ trace_id: "t1", span_id: "keep1", kind: "llm", name: "x" }) + "\n",
      );
      const p = writeStateFile(dir, "expl.json", { trace_id: "t1", pending_spans: ["keep1"] });
      ageFile(p, 3 * HOUR);
      await runScript("sweep.mjs", dir, {
        DBDOG_OBS_REPORT_URL: `http://127.0.0.1:${server.address().port}/api/v2/llmobs/spans`,
        DBDOG_OBS_API_KEY: "k",
        DBDOG_OBS_SWEEP_IDLE_MS: String(HOUR),
        DBDOG_OBS_REPORT_TIMEOUT_MS: "500", // 用户显式配的,sweep 不得动
      });
      expect(JSON.parse(fs.readFileSync(p, "utf8")).pending_spans).toEqual(["keep1"]);
    } finally {
      await new Promise((r) => server.close(r));
    }
  }, 15_000);
});

// —— codex 复审阻断项修复（2026-08-14 第二轮对抗）——
// 接受的六项:①无 Stop 的会话 root 缺失(残树) ②尾部结论进不了重算总结(root 不刷新,
// 而 trimSpans 只读 agent/tool 证据) ③requestId 跨批归并断裂(span 重复+token 双计)
// ④SessionEnd 把历史/别的 trace 的子代理错挂到当前 trace ⑤SessionEnd 用空文本近似
// 覆盖 SubagentStop 的权威 agent span ⑥summary 竞态(旧 worker 后写覆盖)与上报失败
// 既不落 pending 也不留痕。
describe("codex 复审阻断项", () => {
  it("无 Stop 直接 SessionEnd:root 补出来,子 span 不再是孤儿", () => {
    const dir = tempObsDir();
    const tr = path.join(dir, "nostop.jsonl"); // 先 mint(文件尚不存在,游标从 0 起)
    runHook("user-prompt-submit.mjs", { session_id: "ns", prompt: "诊断: 为何慢", cwd: "/tmp/proj", transcript_path: tr }, dir);
    const st = readState(dir, "ns");
    // Stop 从未发生(API 错误/用户中断),整轮内容都在"尾巴"里
    writeTranscript(dir, "nostop.jsonl", [
      { type: "user", uuid: "u1", timestamp: T("00.000"), message: { role: "user", content: "诊断: 为何慢" } },
      {
        type: "assistant", uuid: "a1", timestamp: T("05.000"),
        message: { model: "m", usage: { input_tokens: 1, output_tokens: 2 }, content: [{ type: "text", text: "根因在 X。" }] },
      },
    ]);
    runHook("session-end.mjs", { session_id: "ns", transcript_path: tr, hook_event_name: "SessionEnd", reason: "exit" }, dir);

    const spans = readSpans(dir).filter((s) => s.trace_id === st.trace_id);
    const root = spans.find((s) => s.span_id === st.root_span_id);
    expect(root, "root 必须补出来,否则整树是孤儿").toBeTruthy();
    expect(root.kind).toBe("agent");
    expect(root.input).toContain("诊断: 为何慢");
    expect(root.output).toContain("根因在 X");
    expect(root.ts).toBe(st.started_at); // ts 锚 trace 起点,与 Stop 的 root 同键可折叠
    const llm = spans.filter((s) => s.kind === "llm");
    expect(llm).toHaveLength(1);
    expect(llm[0].parent_id).toBe(st.root_span_id);
  });

  it("requestId 跨 Stop/SessionEnd 批不断裂:同 span_id 同 ts,token 不双计", () => {
    const dir = tempObsDir();
    const tr = path.join(dir, "split.jsonl");
    runHook("user-prompt-submit.mjs", { session_id: "sp", prompt: "诊断: q", cwd: "/tmp/proj", transcript_path: tr }, dir);
    const st = readState(dir, "sp");
    writeTranscript(dir, "split.jsonl", [
      { type: "user", uuid: "u1", timestamp: T("00.000"), message: { role: "user", content: "诊断: q" } },
      {
        type: "assistant", uuid: "a1", requestId: "req_split", timestamp: T("01.000"),
        message: { model: "m", usage: { input_tokens: 10, output_tokens: 20 }, content: [{ type: "text", text: "part1" }] },
      },
    ]);
    runHook("stop.mjs", { session_id: "sp", transcript_path: tr, hook_event_name: "Stop", last_assistant_message: "…" }, dir);
    // 同一响应(同 requestId)的后半行在 Stop 之后才落盘——正是收尾要处理的时序
    fs.appendFileSync(
      tr,
      JSON.stringify({
        type: "assistant", uuid: "a2", requestId: "req_split", timestamp: T("02.000"),
        message: { model: "m", usage: { input_tokens: 10, output_tokens: 20 }, content: [{ type: "text", text: "part2" }] },
      }) + "\n",
    );
    runHook("session-end.mjs", { session_id: "sp", transcript_path: tr, hook_event_name: "SessionEnd", reason: "exit" }, dir);

    const llmRows = readSpans(dir).filter((s) => s.kind === "llm" && s.trace_id === st.trace_id);
    expect(llmRows).toHaveLength(2); // 本地 JSONL 两行是正常的(后写赢)
    expect(new Set(llmRows.map((s) => s.span_id)).size, "同一 requestId 必须同 span_id").toBe(1);
    expect(new Set(llmRows.map((s) => s.ts)).size, "ts 也必须一致,否则排序键折不掉").toBe(1);
    const last = llmRows[llmRows.length - 1];
    expect(last.tokens_output).toBe(20); // usage 是全量重复,不是增量——只算一次
    expect(last.output).toContain("part1");
    expect(last.output).toContain("part2");
    // 复审中危:续写行的 input_local 必须仍是"本次调用之前"的快照——part1 是本次调用
    // 自己的输出,混进去就违反语义(续写沿用首批快照)
    expect(last.input_local ?? "").not.toContain("part1");
    // 复审高危:root 刷新要吃到整段结论(同 requestId 多行合并后的全量,不是只取末行)
    const root = readSpans(dir).filter((s) => s.span_id === st.root_span_id).pop();
    expect(root.output).toContain("part1");
    expect(root.output).toContain("part2");
  });

  it("旧话题的子代理(无状态文件、trace 开始前已停笔)不挂进当前 trace", () => {
    const dir = tempObsDir();
    const tr = path.join(dir, "oldsub.jsonl");
    // 先落一个"历史子代理"的 transcript,mtime 拨老
    const subDir = path.join(dir, "os", "subagents");
    fs.mkdirSync(subDir, { recursive: true });
    const oldAgent = "aold000000000001";
    const subPath = path.join(subDir, `agent-${oldAgent}.jsonl`);
    fs.writeFileSync(
      subPath,
      JSON.stringify({
        type: "assistant", uuid: "os-a", timestamp: "2026-07-14T00:00:00.000Z",
        message: { model: "m", usage: { input_tokens: 1, output_tokens: 1 }, content: [{ type: "text", text: "旧话题产物" }] },
      }) + "\n",
    );
    ageFile(subPath, 3 * HOUR);
    // 之后才铸的新 trace
    runHook("user-prompt-submit.mjs", { session_id: "os", prompt: "诊断: 新问题", cwd: "/tmp/proj", transcript_path: tr }, dir);
    const st = readState(dir, "os");
    runHook("session-end.mjs", { session_id: "os", transcript_path: tr, hook_event_name: "SessionEnd", reason: "exit" }, dir);

    // 守卫生效时本会话零 span,spans.jsonl 可能根本没创建——无文件即零
    const all = fs.existsSync(path.join(dir, "spans.jsonl")) ? readSpans(dir) : [];
    const wrong = all.filter((s) => s.trace_id === st.trace_id && s.tags?.agent_id === oldAgent);
    expect(wrong, "trace 开始前就停笔的子代理不属于本 trace").toHaveLength(0);
  });

  it("SubagentStop 把 trace 归属写进子代理状态;SessionEnd 尊重它,不吞别的 trace 的子代理", () => {
    const dir = tempObsDir();
    const tr = path.join(dir, "attr.jsonl");
    runHook("user-prompt-submit.mjs", { session_id: "at", prompt: "诊断: q", cwd: "/tmp/proj", transcript_path: tr }, dir);
    const st = readState(dir, "at");
    const subDir = path.join(dir, "at", "subagents");
    fs.mkdirSync(subDir, { recursive: true });
    const agentId = "aattr00000000001";
    const at = path.join(subDir, `agent-${agentId}.jsonl`);
    fs.writeFileSync(
      at,
      JSON.stringify({ type: "user", uuid: "s-u", timestamp: T("01.000"), message: { role: "user", content: "去查" } }) + "\n" +
      JSON.stringify({
        type: "assistant", uuid: "s-a", timestamp: T("02.000"),
        message: { model: "m", usage: { input_tokens: 1, output_tokens: 1 }, content: [{ type: "text", text: "查到了" }] },
      }) + "\n",
    );
    runHook(
      "stop.mjs",
      { session_id: "at", hook_event_name: "SubagentStop", agent_id: agentId, agent_transcript_path: at, transcript_path: tr, last_assistant_message: "查到了" },
      dir,
    );
    const sub = JSON.parse(fs.readFileSync(path.join(dir, `at.${agentId}.json`), "utf8"));
    expect(sub.trace_id, "SubagentStop 必须固化 trace 归属").toBe(st.trace_id);

    // 篡改归属模拟"上一条 trace 的子代理"(状态在、trace 不同),再追加新行
    sub.trace_id = "f".repeat(32);
    fs.writeFileSync(path.join(dir, `at.${agentId}.json`), JSON.stringify(sub));
    fs.appendFileSync(
      at,
      JSON.stringify({
        type: "assistant", uuid: "s-b", timestamp: T("03.000"),
        message: { model: "m", usage: { input_tokens: 1, output_tokens: 1 }, content: [{ type: "text", text: "尾行" }] },
      }) + "\n",
    );
    runHook("session-end.mjs", { session_id: "at", transcript_path: tr, hook_event_name: "SessionEnd", reason: "exit" }, dir);
    const stolen = readSpans(dir).filter(
      (s) => s.trace_id === st.trace_id && s.tags?.agent_id === agentId && s.output === "尾行",
    );
    expect(stolen, "归属别的 trace 的子代理尾巴不得挂进当前 trace").toHaveLength(0);
  });

  it("SessionEnd 不用空文本覆盖 SubagentStop 已落定的 agent span", () => {
    const dir = tempObsDir();
    const tr = path.join(dir, "keep.jsonl");
    runHook("user-prompt-submit.mjs", { session_id: "kp", prompt: "诊断: q", cwd: "/tmp/proj", transcript_path: tr }, dir);
    const subDir = path.join(dir, "kp", "subagents");
    fs.mkdirSync(subDir, { recursive: true });
    const agentId = "akeep00000000001";
    const at = path.join(subDir, `agent-${agentId}.jsonl`);
    fs.writeFileSync(
      at,
      JSON.stringify({ type: "user", uuid: "k-u", timestamp: T("01.000"), message: { role: "user", content: "去查" } }) + "\n" +
      JSON.stringify({
        type: "assistant", uuid: "k-a", timestamp: T("02.000"),
        message: { model: "m", usage: { input_tokens: 1, output_tokens: 1 }, content: [{ type: "text", text: "结论文本" }] },
      }) + "\n",
    );
    runHook(
      "stop.mjs",
      { session_id: "kp", hook_event_name: "SubagentStop", agent_id: agentId, agent_transcript_path: at, transcript_path: tr, last_assistant_message: "权威结论" },
      dir,
    );
    // 尾巴只有一条 user 行——没有任何助手文本可作 output
    fs.appendFileSync(
      at,
      JSON.stringify({ type: "user", uuid: "k-u2", timestamp: T("03.000"), message: { role: "user", content: "补一句" } }) + "\n",
    );
    runHook("session-end.mjs", { session_id: "kp", transcript_path: tr, hook_event_name: "SessionEnd", reason: "exit" }, dir);

    const agentRows = readSpans(dir).filter((s) => s.kind === "agent" && s.tags?.agent_id === agentId);
    expect(agentRows, "无新文本就不重发 agent span(后写赢会拿空串覆盖权威 output)").toHaveLength(1);
    expect(agentRows[0].output).toBe("权威结论");
  });
});

// —— summary 代次与送达（codex 复审高危项)——
describe("summary 代次校验与上报失败留痕", () => {
  function startStub(payload, status = 200) {
    const bodies = [];
    const server = http.createServer((req, res) => {
      let body = "";
      req.on("data", (d) => (body += d));
      req.on("end", () => {
        try { bodies.push(JSON.parse(body)); } catch {}
        res.writeHead(status, { "content-type": "application/json" });
        res.end(JSON.stringify(payload));
      });
    });
    return new Promise((r) =>
      server.listen(0, "127.0.0.1", () =>
        r({ url: `http://127.0.0.1:${server.address().port}`, bodies, close: () => new Promise((c) => server.close(c)) }),
      ),
    );
  }
  function runWorker(dir, sessionId, extraEnv) {
    return new Promise((resolve, reject) => {
      const child = spawn(process.execPath, [path.join(HOOK_DIR, "summary-worker.mjs"), sessionId], {
        env: {
          ...process.env,
          DBDOG_OBS_DIR: dir,
          DBDOG_OBS_SPANS: path.join(dir, "spans.jsonl"),
          DBDOG_OBS_REPORT_URL: "",
          DBDOG_OBS_API_KEY: "",
          ...extraEnv,
        },
      });
      child.on("error", reject);
      child.on("close", (code) => resolve(code));
    });
  }
  const TRACE = "9".repeat(32);
  function seed(dir, sessionId) {
    fs.writeFileSync(
      path.join(dir, `${sessionId}.json`),
      JSON.stringify({ active: true, trace_id: TRACE, root_span_id: TRACE.slice(0, 16), session_id: sessionId, started_at: "2026-07-15T00:00:00.000Z" }),
    );
    fs.writeFileSync(
      path.join(dir, "spans.jsonl"),
      JSON.stringify({ trace_id: TRACE, span_id: TRACE.slice(0, 16), kind: "agent", ts: "2026-07-15T00:00:01.000Z", output: "结论" }) + "\n",
    );
  }

  it("代次校验:更高水位的总结已写,旧快照 worker 丢弃自己的结果", async () => {
    const dir = tempObsDir();
    const llm = await startStub({ content: [{ type: "text", text: "旧快照总结" }], usage: {} });
    seed(dir, "gen");
    // 别的 worker 已按更高水位(999 条 span)写过总结
    fs.writeFileSync(path.join(dir, `${TRACE}.summary-gen.json`), JSON.stringify({ watermark: 999 }));
    try {
      await runWorker(dir, "gen", { DBDOG_SUMMARY_LLM_BASE_URL: llm.url, DBDOG_SUMMARY_LLM_API_KEY: "k" });
    } finally {
      await llm.close();
    }
    const sums = readSpans(dir).filter((s) => s.kind === "workflow");
    expect(sums, "旧快照(水位 1)不得覆盖更完整的总结(水位 999)").toHaveLength(0);
  });

  it("上报失败:span_id 落 worker 自己的 sidecar 状态(保持主状态单写者)+ 日志留痕", async () => {
    const dir = tempObsDir();
    const llm = await startStub({ content: [{ type: "text", text: "正文" }], usage: {} });
    const sink = await startStub({}, 500); // 上报端点恒 500
    seed(dir, "rf");
    try {
      await runWorker(dir, "rf", {
        DBDOG_SUMMARY_LLM_BASE_URL: llm.url,
        DBDOG_SUMMARY_LLM_API_KEY: "k",
        DBDOG_OBS_REPORT_URL: sink.url,
        DBDOG_OBS_API_KEY: "k",
      });
    } finally {
      await llm.close();
      await sink.close();
    }
    const sums = readSpans(dir).filter((s) => s.kind === "workflow");
    expect(sums).toHaveLength(1); // 本地真相源照落
    // 复审阻断:worker 不得写主状态(会与持旧快照的 Stop/SessionEnd 互相覆盖)——
    // pending 落 worker 专属 sidecar <session>.summary.json,sweep 同样扫得到、能补发
    const main = JSON.parse(fs.readFileSync(path.join(dir, "rf.json"), "utf8"));
    expect(main.pending_spans ?? []).toEqual([]); // 主状态不被 worker 碰
    const side = JSON.parse(fs.readFileSync(path.join(dir, `rf.summary-${TRACE.slice(0, 16)}.json`), "utf8"));
    expect(side.pending_spans).toContain(sums[0].span_id); // sweep 之后能救
    const log = fs.readFileSync(path.join(dir, "summary-worker.log"), "utf8");
    expect(log).toContain("rf");
    expect(log).toMatch(/report|上报/);
  });

  it("提交段互斥:活锁在手的并发 worker 丢弃自己的结果并留痕", async () => {
    const dir = tempObsDir();
    const llm = await startStub({ content: [{ type: "text", text: "会输的那份" }], usage: {} });
    seed(dir, "lk");
    // 另一个 worker 正持锁提交(锁是新鲜的)
    fs.writeFileSync(path.join(dir, `${TRACE}.summary-lock.json`), JSON.stringify({ pid: 1, at: Date.now() }));
    try {
      await runWorker(dir, "lk", { DBDOG_SUMMARY_LLM_BASE_URL: llm.url, DBDOG_SUMMARY_LLM_API_KEY: "k" });
    } finally {
      await llm.close();
    }
    expect(readSpansSafe(dir).filter((s) => s.kind === "workflow"), "锁在别人手里就不得写").toHaveLength(0);
    const log = fs.readFileSync(path.join(dir, "summary-worker.log"), "utf8");
    expect(log).toMatch(/lock/i);
  });

  it("陈锁可接管:崩溃残留的旧锁不阻塞后来的 worker", async () => {
    const dir = tempObsDir();
    const llm = await startStub({ content: [{ type: "text", text: "接管后写成" }], usage: {} });
    seed(dir, "st");
    const lock = path.join(dir, `${TRACE}.summary-lock.json`);
    fs.writeFileSync(lock, JSON.stringify({ pid: 1, at: 0 }));
    ageFile(lock, HOUR); // 一小时前的陈锁 = worker 崩溃残留
    try {
      await runWorker(dir, "st", { DBDOG_SUMMARY_LLM_BASE_URL: llm.url, DBDOG_SUMMARY_LLM_API_KEY: "k" });
    } finally {
      await llm.close();
    }
    const sums = readSpansSafe(dir).filter((s) => s.kind === "workflow");
    expect(sums, "陈锁必须可接管,否则一次崩溃永久没总结").toHaveLength(1);
    expect(sums[0].output).toBe("接管后写成");
  });

  it("水位=trace 的原始行数(同键重发也涨水位),SessionEnd 的完整快照恒压过 Stop 的残缺快照", async () => {
    const dir = tempObsDir();
    const llm = await startStub({ content: [{ type: "text", text: "总结" }], usage: {} });
    seed(dir, "wm");
    // root 被刷新过一次 → 同 span_id 两行 + llm 一行 = 3 行;unique 只有 2。
    // 若水位按 unique 数,Stop 残缺快照与 SessionEnd 完整快照水位相等,旧 worker 仍可后写覆盖。
    fs.appendFileSync(
      path.join(dir, "spans.jsonl"),
      JSON.stringify({ trace_id: TRACE, span_id: TRACE.slice(0, 16), kind: "agent", ts: "2026-07-15T00:00:01.000Z", output: "结论(刷新)" }) + "\n" +
      JSON.stringify({ trace_id: TRACE, span_id: "llm0000000000001", kind: "llm", ts: "2026-07-15T00:00:02.000Z", output: "推理" }) + "\n",
    );
    try {
      await runWorker(dir, "wm", { DBDOG_SUMMARY_LLM_BASE_URL: llm.url, DBDOG_SUMMARY_LLM_API_KEY: "k" });
    } finally {
      await llm.close();
    }
    const gen = JSON.parse(fs.readFileSync(path.join(dir, `${TRACE}.summary-gen.json`), "utf8"));
    expect(gen.watermark, "水位必须按原始行数(3),不是去重后的 span 数(2)").toBe(3);
  });
});
