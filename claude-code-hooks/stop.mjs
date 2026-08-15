#!/usr/bin/env node
// Stop / SubagentStop — span 合成点：从游标起增量读 transcript JSONL（课题 §2 实测：
// model / usage / 全文 content / tool_use / tool_result / 时间戳全在本地 transcript 里）：
// - 每次模型调用（requestId 归并的 assistant 行组）→ llm span；
// - 每对 tool_use/tool_result → tool span（本地 + MCP 全覆盖、失败也记——DD 参照：
//   Claude Code 官方 OTel 遥测 claude_code.tool 即客户端产出全部工具 span。
//   2026-07-15 治分叉：tool span 从 mcp 服务端双写挪回此处，ADR-0008 补记）；
// - Stop 时另合成/刷新 root agent span（input=用户问题、output=最终回答）。
//
// 2026-08-09 子代理路径追踪：上游 Claude Code 2.1.x 把子代理会话流水拆成了独立文件
// <session>/subagents/agent-<agent_id>.jsonl，主 transcript 里不再有 isSidechain 行。
// SubagentStop 的 transcript_path 仍是主 transcript（与 Stop 相同），子代理那份在
// agent_transcript_path 字段里——此前从没读过它，于是子代理内部的一切工具调用都不可见。
// 现在两条路径分开走：Stop 读主 transcript，SubagentStop 只读 agent_transcript_path。
//
// 树形（v1 平铺已升级为两层）：
//   root agent span
//   └─ tool span "Agent"        父侧调用，span_id = derive(trace_id, agent_id)
//      └─ 子代理的 llm/tool span  parent_id = 同一个派生值
// 输出追加到 spans.jsonl。root span 可能随多次 Stop 重发（同 span_id），读侧按"后写赢"去重。
//
// 2026-08-12 span_id 全面幂等派生：每条 span 的 id 都由 (trace_id, transcript 里的稳定锚)
// 派生——tool 锚 tool_use_id、llm 锚 entry.uuid、子代理锚 agent_id。原先 llm/tool 用
// randomBytes，同一批行被合成两遍（实测成因：同一 Stop 事件被 settings.json 与 plugin
// 各注册一遍，两个进程并行读到同一份未推进的 cursor）就会产出两条不同键的 span，
// ReplacingMergeTree 按 (trace_id, ts, span_id) 折不掉，控制台上每条都显示两遍。
// 派生后重复合成天然收敛为"后写赢"，与 root/子代理 span 一致。
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  readStdinJson,
  readState,
  writeState,
  appendSpans,
  reportSpans,
  cap,
  run,
  deriveSpanId,
  lookupSpans,
  pendingIds,
} from "./lib.mjs";
import { PENDING_TOOL_USE_MAX, msBetween, readNewLines, synthesize } from "./synthesize.mjs";
import { summaryEnv } from "./summary.mjs";

/** 诊断流程总结 detached worker（与 stop.mjs 同目录）。 */
const WORKER = path.join(path.dirname(fileURLToPath(import.meta.url)), "summary-worker.mjs");

/**
 * 落盘 + 上报；返回未成功送达的 **span_id 列表**（留待下次重试）。
 * 本地 JSONL 永远先落（真相源），所以 pending 只需记 id，用时回捞——
 * 存全文会把状态文件撑到数百 KB（实测 315 KB）。
 */
async function emit(spans, carriedOverIds) {
  appendSpans(spans);
  const batch = [...lookupSpans(carriedOverIds), ...spans];
  const reported = await reportSpans(batch);
  return reported ? [] : batch.map((s) => s.span_id);
}

/**
 * SubagentStop：只读 agent_transcript_path，只写该子代理自己的状态文件。
 * 主 state 一律只读不写——并行子代理会同时触发本分支，碰主 state 必然互相覆盖。
 */
async function handleSubagent(input, main) {
  const agentId = input.agent_id;
  const transcript = input.agent_transcript_path;
  // 老版 Claude Code 不给这两个字段（那会儿子代理内容就写在主 transcript 里，
  // Stop 一并读得到）——静默跳过，别去动主 state。
  if (!agentId || !transcript) return;

  const sub = readState(input.session_id, agentId) ?? {};
  const { lines, nextCursor } = readNewLines(transcript, sub.cursor ?? 0);

  // 两个 id 都从 (trace_id, agent_id) 派生，父侧那条加 "tool:" 前缀区分：
  //   root → [tool] Agent（父视角的调用）→ [agent] 子代理自己 → 子代理的 llm/tool
  const selfSpanId = deriveSpanId(main.trace_id, agentId);
  const parentToolSpanId = deriveSpanId(main.trace_id, `tool:${agentId}`);

  const { spans, pendingToolUses, lastEntryTs, firstEntryTs, firstUserText, ctxBuf, partialLlm } = synthesize({
    lines,
    traceId: main.trace_id,
    sessionId: main.session_id ?? input.session_id,
    parentId: selfSpanId,
    mlApp: main.ml_app,
    pendingToolUses: new Map(Object.entries(sub.pending_tool_uses ?? {})),
    lastEntryTs: sub.last_entry_ts ?? null,
    agent: { id: agentId, type: input.agent_type ?? null },
    ctxBuf: sub.ctx_buf ?? "",
    partialLlm: sub.partial_llm ?? null,
  });

  // 子代理自己的 agent span（一个自治单元 = 一条 agent span，便于按 kind 数出
  // 这条 trace 用了几个子代理）。同 span_id 可随重入重发，读侧"后写赢"。
  const startedAt = sub.started_at ?? firstEntryTs;
  const prompt = sub.prompt ?? firstUserText;
  if (startedAt) {
    spans.push({
      trace_id: main.trace_id,
      span_id: selfSpanId,
      parent_id: parentToolSpanId,
      session_id: main.session_id ?? input.session_id,
      kind: "agent",
      name: "claude-code.subagent",
      model: null,
      status: "ok",
      ts: startedAt,
      duration_ms: msBetween(startedAt, lastEntryTs),
      input: cap(prompt ?? ""),
      output: cap(typeof input.last_assistant_message === "string" ? input.last_assistant_message : ""),
      tokens_input: null,
      tokens_output: null,
      tokens_cache_read: null,
      tokens_cache_creation: null,
      tags: {
        sidechain: "1",
        agent_id: agentId,
        ...(input.agent_type ? { agent_type: input.agent_type } : {}),
        ...(main.ml_app ? { ml_app: main.ml_app } : {}),
      },
    });
  }

  const pending = await emit(spans, pendingIds(sub.pending_spans));
  writeState(
    input.session_id,
    {
      cursor: nextCursor,
      pending_spans: pending,
      last_entry_ts: lastEntryTs,
      started_at: startedAt ?? null,
      prompt: prompt ?? null,
      pending_tool_uses: Object.fromEntries([...pendingToolUses.entries()].slice(-PENDING_TOOL_USE_MAX)),
      ctx_buf: ctxBuf,
      // trace 归属固化（codex 复审阻断项）：SessionEnd 收尾时只认归属当前 trace 的子代理，
      // 不把上一条 trace 的子代理尾巴错挂进来。
      trace_id: main.trace_id,
      partial_llm: partialLlm ?? null,
    },
    agentId,
  );
}

/**
 * 收上一条 trace 交界时未落盘的尾巴（state.carry 由 user-prompt-submit 在铸造/停用时记下）。
 *
 * 成因：Stop 读 transcript 时，本轮收尾那几行（通常正是产出结论的 assistant 行）往往还没落盘；
 * 而下一条 trace 铸造时游标跳到交界处，那几行就永久没人合成——实测每条 trace 恒定丢最后一轮的
 * llm span（token 计数最有价值的那条）。字节级证据：cursor=8292 / 文件 10906，8292–10672
 * 那两行带完整 usage 的 assistant 一直没被读到。
 *
 * 按 carry 里记的**旧** trace_id / root_span_id 补合成，区间上界是交界时刻的文件大小，
 * 所以绝不会把新一轮的内容错记到旧 trace 上。收完即清（不重试第二次——本地 JSONL 才是真相源）。
 * 返回是否动过 state（调用方据此决定要不要写盘）。
 */
async function flushCarry(input, state) {
  const c = state.carry;
  if (!c) return false;
  delete state.carry;
  const transcript = c.transcript_path ?? input.transcript_path ?? state.transcript_path;
  if (!c.trace_id || !transcript || !(c.to > c.from)) return true;

  const { lines } = readNewLines(transcript, c.from, c.to);
  if (!lines.length) return true;

  const { spans } = synthesize({
    lines,
    traceId: c.trace_id,
    sessionId: c.session_id ?? state.session_id,
    parentId: c.root_span_id,
    mlApp: c.ml_app,
    pendingToolUses: new Map(Object.entries(c.pending_tool_uses ?? {})),
    lastEntryTs: c.last_entry_ts ?? null,
    agent: null,
    ctxBuf: "", // 收尾批不再滚上下文：input_local 由那条 trace 已发出的 llm span 覆盖
    partialLlm: c.partial_llm ?? null,
  });
  if (!spans.length) return true;

  const pending = await emit(spans, []);
  state.pending_spans = [...pendingIds(state.pending_spans), ...pending];
  return true;
}

/** Stop：读主 transcript，合成本轮 llm/tool span，并合成/刷新 root agent span。 */
async function handleMain(input, state) {
  const transcript = input.transcript_path ?? state.transcript_path;
  if (!transcript) return;

  const { lines, nextCursor } = readNewLines(transcript, state.cursor ?? 0);
  const { spans, pendingToolUses, lastEntryTs, ctxBuf, partialLlm } = synthesize({
    lines,
    traceId: state.trace_id,
    sessionId: state.session_id,
    parentId: state.root_span_id,
    mlApp: state.ml_app,
    pendingToolUses: new Map(Object.entries(state.pending_tool_uses ?? {})),
    lastEntryTs: state.last_entry_ts ?? null,
    agent: null,
    ctxBuf: state.ctx_buf ?? "",
    partialLlm: state.partial_llm ?? null,
  });
  // 本轮新增的工具调用数（= 诊断有新进展的信号；纯 Q&A 回合无新工具，不触发总结重算）。
  const newToolCount = spans.filter((s) => s.kind === "tool").length;

  // root agent span：同 span_id 重发，后写赢。
  spans.push({
    trace_id: state.trace_id,
    span_id: state.root_span_id,
    parent_id: null,
    session_id: state.session_id,
    kind: "agent",
    name: "claude-code.task",
    model: null,
    status: "ok",
    ts: state.started_at,
    duration_ms: state.started_at ? Date.now() - Date.parse(state.started_at) : null,
    input: cap(state.prompt ?? ""),
    output: cap(typeof input.last_assistant_message === "string" ? input.last_assistant_message : ""),
    tokens_input: null,
    tokens_output: null,
    tokens_cache_read: null,
    tokens_cache_creation: null,
    tags: { trace_source: "client", ...(state.ml_app ? { ml_app: state.ml_app } : {}) },
  });
  state.root_emitted = true;

  const pending = await emit(spans, pendingIds(state.pending_spans));
  state.cursor = nextCursor;
  state.pending_spans = pending;
  state.last_entry_ts = lastEntryTs;
  state.ctx_buf = ctxBuf;
  state.partial_llm = partialLlm ?? null;
  state.pending_tool_uses = Object.fromEntries(
    [...pendingToolUses.entries()].slice(-PENDING_TOOL_USE_MAX),
  );
  writeState(input.session_id, state);

  // 诊断流程总结：本轮有新工具调用、且配了本地大模型 → 后台 detach 起 worker 生成总结。
  // 不 await、不阻塞 Stop（用户零等待）；worker 读 spans.jsonl 真相源、按固定 span_id 后写赢。
  // 失败必须吞掉——spawn 不得打断会话。
  if (newToolCount > 0 && summaryEnv()) {
    try {
      const child = spawn(process.execPath, [WORKER, input.session_id], {
        detached: true,
        stdio: "ignore",
      });
      child.once("error", () => {}); // spawn 的运行期失败走异步 error 事件,不接住会崩掉 hook
      child.unref();
    } catch {
      /* best-effort：起不来就这次没总结，不影响 trace */
    }
  }
}

run(async () => {
  const input = await readStdinJson();
  const state = readState(input.session_id);
  if (!state?.trace_id) return; // 无 trace 归属 → 不产 span、不上报

  if (input.hook_event_name === "SubagentStop") {
    if (state.active === false) return; // 触发门（DBDOG_OBS_MODE）
    await handleSubagent(input, state);
    return;
  }

  // 交界收尾先做：state.active 已经是 false 也要收——那正是"换了话题"的情形，
  // 旧 trace 的最后一轮 llm span 就藏在 carry 区间里。收完即止，不产新 span。
  const flushed = await flushCarry(input, state);
  if (state.active === false) {
    if (flushed) writeState(input.session_id, state);
    return;
  }
  await handleMain(input, state);
});
