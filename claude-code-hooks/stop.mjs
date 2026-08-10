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
import crypto from "node:crypto";
import fs from "node:fs";
import {
  readStdinJson,
  readState,
  writeState,
  appendSpans,
  reportSpans,
  cap,
  contentCap,
  storeLlmInput,
  ctxBufCap,
  run,
  deriveSpanId,
  lookupSpans,
  pendingIds,
} from "./lib.mjs";

/** 从字节游标起读取完整行；返回 { lines, nextCursor }（未换行收尾的残行不消费）。 */
function readNewLines(file, cursor) {
  const size = fs.statSync(file).size;
  if (size <= cursor) return { lines: [], nextCursor: cursor };
  const fd = fs.openSync(file, "r");
  try {
    const buf = Buffer.alloc(size - cursor);
    fs.readSync(fd, buf, 0, buf.length, cursor);
    const text = buf.toString("utf8");
    const lastNl = text.lastIndexOf("\n");
    if (lastNl < 0) return { lines: [], nextCursor: cursor };
    return {
      lines: text.slice(0, lastNl).split("\n").filter(Boolean),
      nextCursor: cursor + Buffer.byteLength(text.slice(0, lastNl + 1), "utf8"),
    };
  } finally {
    fs.closeSync(fd);
  }
}

/** assistant 消息的可读输出：文本块全文 + tool_use 标记（名字，不含参数）。 */
function assistantText(content) {
  if (!Array.isArray(content)) return "";
  return content
    .map((b) => (b?.type === "text" ? b.text : b?.type === "tool_use" ? `[tool_use: ${b.name}]` : ""))
    .filter(Boolean)
    .join("\n");
}

/** tool_result 的可读输出：string 直取；块数组取文本块，无文本块退回 JSON 串。 */
function toolResultText(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  const texts = content.map((b) => (b?.type === "text" ? b.text : "")).filter(Boolean);
  if (texts.length) return texts.join("\n");
  try {
    return JSON.stringify(content);
  } catch {
    return "";
  }
}

/** 截尾版 cap：每轮 prompt 的诊断价值在"新注入的尾部"（上下文为什么膨胀看的就是它），
 *  取后 contentCap 字符；头部（系统提示/初始 prompt）由 root/agent span 的 input 覆盖。 */
function capTail(s) {
  if (typeof s !== "string") return null;
  const c = contentCap();
  return s.length > c ? s.slice(-c) : s;
}

/** 两个 ISO 时间戳的毫秒差；不可算（缺值/乱序）→ null。 */
function msBetween(fromIso, toIso) {
  const a = Date.parse(fromIso ?? "");
  const b = Date.parse(toIso ?? "");
  if (!Number.isFinite(a) || !Number.isFinite(b) || b < a) return null;
  return b - a;
}

/**
 * 从最终回答里抽取诊断流程叙事总结。
 * agent（受 investigate skill 指令约束）在回答末尾用 HTML 注释哨兵包裹一段叙事：
 *   <!-- dbdog-diagnosis-summary --> …叙事… <!-- /dbdog-diagnosis-summary -->
 * 哨兵在 markdown 渲染时不可见（段落作为正常散文给诊断者复盘）；此处靠哨兵稳定抽取，
 * 铸成独立 summary span 随 root 一起推送，前端「诊断流程总结」banner 直接渲染——
 * 不再 web 侧按需调 LLM（同一大脑 inline 写、零额外调用、省 token）。
 * 抽不到 / 空 → null（不产 span，不静默造）。
 */
function extractSummary(lastAssistantMessage) {
  if (typeof lastAssistantMessage !== "string" || !lastAssistantMessage) return null;
  const m = lastAssistantMessage.match(
    /<!--\s*dbdog-diagnosis-summary\s*-->([\s\S]*?)<!--\s*\/dbdog-diagnosis-summary\s*-->/
  );
  const body = m ? m[1].trim() : "";
  return body || null;
}

/** 未配对 tool_use 跨批携带上限（state 文件防膨胀；超限丢最旧）。 */
const PENDING_TOOL_USE_MAX = 200;

/** 起子代理的工具名（父侧那一次调用，其 tool_result 携带 toolUseResult.agentId）。 */
const SUBAGENT_TOOLS = new Set(["Agent", "Task"]);

/**
 * 从 transcript 新增行合成 llm + tool span。
 * 主会话与子代理共用这一套：实测子代理那份 transcript 与主 transcript 完全同构
 * （requestId / message.usage / model / tool_use / tool_result 齐全），差别只是
 * isSidechain=true 且多了 agentId。
 *
 * @param parentId  本批 span 挂的父节点（主线=root span；子代理=父侧 Agent tool span 的派生 id）
 * @param agent     非空表示正在处理子代理那份 transcript，span 上补 agent_id/agent_type
 * @param ctxBuf    上一批带来的滚动上下文缓冲（每轮 prompt 从这里截）
 */
function synthesize({ lines, traceId, sessionId, parentId, mlApp, pendingToolUses, lastEntryTs, agent, ctxBuf }) {
  const spans = [];
  const agentTags = agent ? { agent_id: agent.id, ...(agent.type ? { agent_type: agent.type } : {}) } : {};
  // 子代理 agent span 的 ts 与 input：实测子代理 transcript 首行即 type=user、
  // content 为字符串的那条 prompt。
  let firstEntryTs = null;
  let firstUserText = null;

  // 每轮完整 prompt（DBDOG_OBS_STORE_LLM_INPUT，本地落盘）：按出现顺序把消息正文滚进
  // 缓冲、只留尾部 ctxBufCap 字符——每轮 llm span 的 input_local 取"该轮模型调用之前的
  // 快照"，截尾存。近似声明：系统提示不在 transcript 里（头部由 root/agent span 的
  // input 覆盖）；tool_use 只留名字标记不进正文（参数在 tool span 里，重复存没意义）；
  // 长度以 usage 的 token 计数为准，正文只是给复盘看内容。
  let ctx = ctxBuf ?? "";
  const ctxCap = ctxBufCap();
  const pushCtx = (s) => {
    if (!s) return;
    const next = ctx ? `${ctx}\n${s}` : s; // 空缓冲首推不带前导换行
    ctx = next.length > ctxCap ? next.slice(-ctxCap) : next;
  };

  // 按 requestId 归并（实测坑，2026-07-09 首轮闭环发现）：一次 API 响应会按内容块拆成
  // 多条 assistant 行——requestId 相同、usage 逐行重复。一次模型调用 = 一个 llm span，
  // 逐行出 span 会把轮数虚增 2-3 倍。无 requestId 的行各自成组（合成 transcript 兼容）。
  const groups = [];
  let cur = null;
  for (const [i, line] of lines.entries()) {
    let entry;
    try {
      entry = JSON.parse(line);
    } catch {
      continue; // 容忍脏行
    }

    if (entry?.timestamp && firstEntryTs == null) firstEntryTs = entry.timestamp;
    if (firstUserText == null && entry?.type === "user" && typeof entry.message?.content === "string") {
      firstUserText = entry.message.content;
      pushCtx(`[user]\n${entry.message.content}`);
    }

    if (entry?.type === "assistant" && Array.isArray(entry.message?.content)) {
      // 收集 tool_use（所有工具，含本地 Bash/Read 等；MCP 工具剥 telemetry 块、提 intent）
      for (const b of entry.message.content) {
        if (b?.type !== "tool_use" || !b.id) continue;
        const mcp = /^mcp__(.+?)__(.+)$/.exec(b.name ?? "");
        let args = b.input;
        let intent = "";
        if (mcp && args && typeof args === "object" && args.telemetry) {
          const { telemetry, ...rest } = args;
          intent = typeof telemetry?.intent === "string" ? telemetry.intent : "";
          args = rest;
        }
        let inputJson = null;
        try {
          inputJson = cap(JSON.stringify(args));
        } catch {
          /* 入参不可序列化就置空 */
        }
        pendingToolUses.set(b.id, {
          name: mcp ? mcp[2] : (b.name ?? "unknown"),
          mcp_server: mcp ? mcp[1] : null,
          intent,
          input: inputJson,
          ts: entry.timestamp ?? null,
          sidechain: agent || entry.isSidechain ? "1" : "0",
        });
      }

      if (entry.message?.usage) {
        const rid = entry.requestId ?? `line-${i}`;
        if (cur && cur.rid === rid) cur.entries.push(entry);
        else {
          // 新组的时长近似起点 = 组首行之前那条 entry 的落盘时刻（通常是触发本次
          // 模型调用的 user/tool_result 行）。transcript 无请求发起时刻，这是下批近似。
          // ctxSnapshot 取在本行内容入缓冲之前 = "该轮模型调用实际看到的上下文"。
          cur = { rid, entries: [entry], startTs: lastEntryTs, ctxSnapshot: ctx };
          groups.push(cur);
        }
      }
      // 本轮输出进缓冲（下一轮的 prompt 包含它）；tool_use 只留名字标记，参数不入
      pushCtx(`[assistant]\n${assistantText(entry.message.content)}`);
    }

    // tool_result 配对（在 user 行里；is_error 的失败调用照记——transport 断掉的
    // MCP 调用也在这里留痕，服务端视角反而看不见）
    if (entry?.type === "user" && Array.isArray(entry.message?.content)) {
      // 本轮注入的内容先进缓冲（模型下一轮会看到）：tool_result 正文 + 夹带的文本块
      for (const b of entry.message.content) {
        if (b?.type === "tool_result") pushCtx(`[tool_result ${b.tool_use_id}]\n${toolResultText(b.content)}`);
        else if (typeof b?.text === "string") pushCtx(`[user]\n${b.text}`);
      }
      for (const b of entry.message.content) {
        if (b?.type !== "tool_result" || !b.tool_use_id) continue;
        const use = pendingToolUses.get(b.tool_use_id);
        if (!use) continue;
        pendingToolUses.delete(b.tool_use_id);

        // 父侧起子代理的那次调用：span_id 不能随机，必须与 SubagentStop 侧算出同一个值——
        // 子代理的 span 早在这一行落盘之前就写出去了，只能靠 (trace_id, agent_id) 派生对齐。
        // 加 "tool:" 前缀是为了跟子代理自己的 agent span 区分开（两者都由 agent_id 派生）。
        const result = SUBAGENT_TOOLS.has(use.name) ? entry.toolUseResult : null;
        const subAgentId = result?.agentId ?? null;
        const spanId = subAgentId
          ? deriveSpanId(traceId, `tool:${subAgentId}`)
          : crypto.randomBytes(8).toString("hex");

        // 子代理的总开销：toolUseResult 里现成就有，不打上去等于白扔——有了它们，
        // 不展开子树就能看出这个子代理烧了多少。走 tags（字符串）而非 tokens_* 一等
        // 字段：子代理内部的 llm span 已经各自记了 token，占一等字段会被重复求和。
        const subAgentTags = subAgentId
          ? {
              agent_id: subAgentId,
              ...(result.agentType ? { agent_type: result.agentType } : {}),
              ...(result.resolvedModel ? { agent_model: result.resolvedModel } : {}),
              ...(Number.isFinite(result.totalTokens)
                ? { agent_total_tokens: String(result.totalTokens) }
                : {}),
              ...(Number.isFinite(result.totalToolUseCount)
                ? { agent_tool_use_count: String(result.totalToolUseCount) }
                : {}),
            }
          : {};

        spans.push({
          trace_id: traceId,
          span_id: spanId,
          parent_id: parentId,
          session_id: sessionId,
          kind: "tool",
          name: use.name,
          model: null,
          status: b.is_error ? "error" : "ok",
          ts: use.ts ?? entry.timestamp ?? new Date().toISOString(),
          duration_ms: msBetween(use.ts, entry.timestamp),
          input: use.input,
          output: cap(toolResultText(b.content)),
          intent: use.intent || undefined,
          tokens_input: null,
          tokens_output: null,
          tokens_cache_read: null,
          tokens_cache_creation: null,
          tags: {
            sidechain: use.sidechain,
            ...(mlApp ? { ml_app: mlApp } : {}),
            ...(use.mcp_server ? { mcp_server: use.mcp_server } : {}),
            ...agentTags,
            ...subAgentTags,
          },
        });
      }
    }

    if (entry?.timestamp) lastEntryTs = entry.timestamp;
  }

  for (const g of groups) {
    const first = g.entries[0];
    const last = g.entries[g.entries.length - 1];
    const msg = last.message; // usage/stop_reason 各行重复，取末行；输出拼全组
    // 时长近似：前一条 entry 落盘 → 组内末行落盘。含少量客户端编组开销、略高估；
    // 打 duration_estimated 标与真实测量区分（DD SDK 包住 API 调用才有真时长）。
    // ts 用同一基线（startTs）——否则 ts=首行落盘 + duration=从前一条起算，
    // span 终点会越过 root 终点（0.2.0 实测 39s 过冲）。
    const duration = msBetween(g.startTs, last.timestamp);
    spans.push({
      trace_id: traceId,
      span_id: crypto.randomBytes(8).toString("hex"),
      parent_id: parentId,
      session_id: sessionId,
      kind: "llm",
      name: "anthropic.messages",
      model: msg.model ?? null,
      status: "ok",
      ts: (duration != null ? g.startTs : first.timestamp) ?? new Date().toISOString(),
      duration_ms: duration,
      input: null, // 上报侧恒 null：远端只看 token；完整 prompt 走 input_local 纯本地
      // input_local：该轮模型调用实际看到的上下文（截尾，contentCap 控制长度）。
      // 开关 DBDOG_OBS_STORE_LLM_INPUT=0 可关；只在 spans.jsonl，reportSpans 前剥离。
      ...(storeLlmInput() ? { input_local: capTail(g.ctxSnapshot ?? "") } : {}),
      output: cap(g.entries.map((e) => assistantText(e.message?.content)).filter(Boolean).join("\n")),
      tokens_input: msg.usage.input_tokens ?? null,
      tokens_output: msg.usage.output_tokens ?? null,
      tokens_cache_read: msg.usage.cache_read_input_tokens ?? null,
      tokens_cache_creation: msg.usage.cache_creation_input_tokens ?? null,
      tags: {
        sidechain: agent || first.isSidechain ? "1" : "0",
        ...(duration != null ? { duration_estimated: "1" } : {}),
        ...(mlApp ? { ml_app: mlApp } : {}),
        ...(first.requestId ? { request_id: first.requestId } : {}),
        ...(msg.stop_reason ? { stop_reason: msg.stop_reason } : {}),
        ...agentTags,
      },
    });
  }

  return { spans, pendingToolUses, lastEntryTs, firstEntryTs, firstUserText, ctxBuf: ctx };
}

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

  const { spans, pendingToolUses, lastEntryTs, firstEntryTs, firstUserText, ctxBuf } = synthesize({
    lines,
    traceId: main.trace_id,
    sessionId: main.session_id ?? input.session_id,
    parentId: selfSpanId,
    mlApp: main.ml_app,
    pendingToolUses: new Map(Object.entries(sub.pending_tool_uses ?? {})),
    lastEntryTs: sub.last_entry_ts ?? null,
    agent: { id: agentId, type: input.agent_type ?? null },
    ctxBuf: sub.ctx_buf ?? "",
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
    },
    agentId,
  );
}

/** Stop：读主 transcript，合成本轮 llm/tool span，并合成/刷新 root agent span。 */
async function handleMain(input, state) {
  const transcript = input.transcript_path ?? state.transcript_path;
  if (!transcript) return;

  const { lines, nextCursor } = readNewLines(transcript, state.cursor ?? 0);
  const { spans, pendingToolUses, lastEntryTs, ctxBuf } = synthesize({
    lines,
    traceId: state.trace_id,
    sessionId: state.session_id,
    parentId: state.root_span_id,
    mlApp: state.ml_app,
    pendingToolUses: new Map(Object.entries(state.pending_tool_uses ?? {})),
    lastEntryTs: state.last_entry_ts ?? null,
    agent: null,
    ctxBuf: state.ctx_buf ?? "",
  });

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

  // 诊断流程叙事 summary span：agent 在最终回答里自写的哨兵段落抽出来铸成独立 span。
  // span_id 从 (trace_id,"summary") 派生——多次 Stop 重发同 id，读侧"后写赢"去重，
  // 与 root 同批进 emit（sweep.mjs 重发路径也能带上，无需特殊处理）。抽不到则不产。
  const narrative = extractSummary(input.last_assistant_message);
  if (narrative) {
    spans.push({
      trace_id: state.trace_id,
      span_id: deriveSpanId(state.trace_id, "summary"),
      parent_id: state.root_span_id,
      session_id: state.session_id,
      kind: "workflow",
      name: "diagnosis.summary",
      model: null,
      status: "ok",
      ts: lastEntryTs ?? new Date().toISOString(),
      duration_ms: null,
      input: null,
      output: cap(narrative),
      tokens_input: null,
      tokens_output: null,
      tokens_cache_read: null,
      tokens_cache_creation: null,
      tags: { trace_source: "client", summary: "1", ...(state.ml_app ? { ml_app: state.ml_app } : {}) },
    });
  }

  const pending = await emit(spans, pendingIds(state.pending_spans));
  state.cursor = nextCursor;
  state.pending_spans = pending;
  state.last_entry_ts = lastEntryTs;
  state.ctx_buf = ctxBuf;
  state.pending_tool_uses = Object.fromEntries(
    [...pendingToolUses.entries()].slice(-PENDING_TOOL_USE_MAX),
  );
  writeState(input.session_id, state);
}

run(async () => {
  const input = await readStdinJson();
  const state = readState(input.session_id);
  // 无 trace 归属或本轮未触发（DBDOG_OBS_MODE 触发门）→ 不产 span、不上报
  if (!state?.trace_id || state.active === false) return;

  if (input.hook_event_name === "SubagentStop") await handleSubagent(input, state);
  else await handleMain(input, state);
});
