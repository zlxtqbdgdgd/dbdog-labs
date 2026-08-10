import { afterEach, describe, expect, it } from "vitest";
import { spawn, spawnSync } from "node:child_process";
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

// —— 诊断流程叙事 summary span（agent 自写哨兵段落，stop.mjs 抽取铸 span）——
// agent 在最终回答末尾用 <!-- dbdog-diagnosis-summary --> 哨兵包裹一段叙事（investigate
// skill 指令约束），stop.mjs 抽出来铸成独立 summary span 随 root 推送——前端 banner 直接
// 渲染，不再 web 侧按需调 LLM。
describe("诊断流程叙事 summary span", () => {
  function minTranscript(dir) {
    return writeTranscript(dir, "min.jsonl", [
      { type: "user", timestamp: T("00.000"), message: { role: "user", content: "诊断: 为什么卡住" } },
      {
        type: "assistant",
        timestamp: T("05.000"),
        requestId: "r1",
        message: { model: "m", usage: { input_tokens: 1, output_tokens: 1 }, content: [{ type: "text", text: "结论" }] },
      },
    ]);
  }

  it("抽取哨兵段落铸成 diagnosis.summary span，挂 root、内容为叙事正文", () => {
    const dir = tempObsDir();
    const transcript = minTranscript(dir);
    seedState(dir, "sum1", transcript);
    const narrative =
      "实例 pg-prod 上 `get_dbdog_database_health_signals` 返回 **p95 2.3s**，随即查 `get_dbdog_database_query_performance` 锁定 signature X。";
    runHook(
      "stop.mjs",
      {
        session_id: "sum1",
        transcript_path: transcript,
        hook_event_name: "Stop",
        last_assistant_message: `结论如下。\n\n<!-- dbdog-diagnosis-summary -->\n${narrative}\n<!-- /dbdog-diagnosis-summary -->`,
      },
      dir,
    );
    const sum = readSpans(dir).find((s) => s.name === "diagnosis.summary");
    expect(sum, "应铸出 diagnosis.summary span").toBeDefined();
    expect(sum.kind).toBe("workflow");
    expect(sum.parent_id).toBe("a".repeat(16)); // root
    expect(sum.output).toBe(narrative);
    expect(sum.tags.summary).toBe("1");
    expect(sum.tags.trace_source).toBe("client");
  });

  it("无哨兵段落时不产 summary span（不静默造）", () => {
    const dir = tempObsDir();
    const transcript = minTranscript(dir);
    seedState(dir, "sum2", transcript);
    runHook(
      "stop.mjs",
      { session_id: "sum2", transcript_path: transcript, hook_event_name: "Stop", last_assistant_message: "结论如下，没有叙事块。" },
      dir,
    );
    expect(readSpans(dir).find((s) => s.name === "diagnosis.summary")).toBeUndefined();
  });

  it("多个哨兵块取首个", () => {
    const dir = tempObsDir();
    const transcript = minTranscript(dir);
    seedState(dir, "sum3", transcript);
    runHook(
      "stop.mjs",
      {
        session_id: "sum3",
        transcript_path: transcript,
        hook_event_name: "Stop",
        last_assistant_message:
          "<!-- dbdog-diagnosis-summary -->\n第一段\n<!-- /dbdog-diagnosis-summary -->\n<!-- dbdog-diagnosis-summary -->\n第二段\n<!-- /dbdog-diagnosis-summary -->",
      },
      dir,
    );
    expect(readSpans(dir).find((s) => s.name === "diagnosis.summary").output).toBe("第一段");
  });

  it("summary span_id 从 (trace_id, summary) 派生，多次 Stop 重发同 id（后写赢去重）", () => {
    const dir = tempObsDir();
    const transcript = minTranscript(dir);
    seedState(dir, "sum4", transcript);
    const input = {
      session_id: "sum4",
      transcript_path: transcript,
      hook_event_name: "Stop",
      last_assistant_message: "<!-- dbdog-diagnosis-summary -->\nv1\n<!-- /dbdog-diagnosis-summary -->",
    };
    runHook("stop.mjs", input, dir);
    // 第二次：transcript 无新增行，但 root + summary 仍重发刷新（last-write-wins）
    input.last_assistant_message = "<!-- dbdog-diagnosis-summary -->\nv2\n<!-- /dbdog-diagnosis-summary -->";
    runHook("stop.mjs", input, dir);
    const sums = readSpans(dir).filter((s) => s.name === "diagnosis.summary");
    expect(new Set(sums.map((s) => s.span_id)).size, "多次 Stop 重发同 span_id").toBe(1);
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
