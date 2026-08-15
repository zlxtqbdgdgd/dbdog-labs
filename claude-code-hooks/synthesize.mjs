// 共享合成核心：从 transcript JSONL 行合成 llm/tool span。
// 2026-08-14 自 stop.mjs 原样抽出（逻辑零改动），供 stop.mjs（Stop/SubagentStop 增量合成）
// 与 session-end.mjs（会话直接结束的收尾）共用——此前 stop.mjs 顶层就执行 run()，
// 无法被 import 复用，只能整段搬家。
import fs from "node:fs";
import { cap, contentCap, ctxBufCap, deriveSpanId, storeLlmInput } from "./lib.mjs";

/**
 * 从字节游标起读取完整行；返回 { lines, nextCursor }（未换行收尾的残行不消费）。
 * `until` 给上界（用于 carry 的区间读，见 stop.mjs flushCarry）；缺省读到文件末尾。
 */
export function readNewLines(file, cursor, until) {
  const size = Math.min(until ?? Infinity, fs.statSync(file).size);
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
export function assistantText(content) {
  if (!Array.isArray(content)) return "";
  return content
    .map((b) => (b?.type === "text" ? b.text : b?.type === "tool_use" ? `[tool_use: ${b.name}]` : ""))
    .filter(Boolean)
    .join("\n");
}

/** tool_result 的可读输出：string 直取；块数组取文本块，无文本块退回 JSON 串。 */
export function toolResultText(content) {
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
export function capTail(s) {
  if (typeof s !== "string") return null;
  const c = contentCap();
  return s.length > c ? s.slice(-c) : s;
}

/** 两个 ISO 时间戳的毫秒差；不可算（缺值/乱序）→ null。 */
export function msBetween(fromIso, toIso) {
  const a = Date.parse(fromIso ?? "");
  const b = Date.parse(toIso ?? "");
  if (!Number.isFinite(a) || !Number.isFinite(b) || b < a) return null;
  return b - a;
}

/** 未配对 tool_use 跨批携带上限（state 文件防膨胀；超限丢最旧）。 */
export const PENDING_TOOL_USE_MAX = 200;

/** 起子代理的工具名（父侧那一次调用，其 tool_result 携带 toolUseResult.agentId）。 */
export const SUBAGENT_TOOLS = new Set(["Agent", "Task"]);

/**
 * 从 transcript 新增行合成 llm + tool span。
 * 主会话与子代理共用这一套：实测子代理那份 transcript 与主 transcript 完全同构
 * （requestId / message.usage / model / tool_use / tool_result 齐全），差别只是
 * isSidechain=true 且多了 agentId。
 *
 * @param parentId  本批 span 挂的父节点（主线=root span；子代理=父侧 Agent tool span 的派生 id）
 * @param agent     非空表示正在处理子代理那份 transcript，span 上补 agent_id/agent_type
 * @param ctxBuf    上一批带来的滚动上下文缓冲（每轮 prompt 从这里截）
 * @param partialLlm 上一批尾组的延续信息（2026-08-14 codex 复审阻断项:同一 requestId 的
 *   多条 assistant 行被 Stop/SessionEnd 拆成两批读时,第二批若各自成组、用自己的 uuid 派生
 *   span_id,就是两条不同键的 llm span——usage 是逐行全量重复的,token 直接双计。
 *   延续信息 {rid, anchor, ts, start_ts, output}:第二批的首组若 requestId 与 rid 相同,
 *   复用 anchor(同 span_id)与 ts(同排序键,后写赢真正折叠),output 前拼上前半段。）
 */
export function synthesize({ lines, traceId, sessionId, parentId, mlApp, pendingToolUses, lastEntryTs, agent, ctxBuf, partialLlm }) {
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
          // anchor = span_id 的派生锚：优先 entry.uuid（实测每行都有，且跨进程稳定），
          // 退 requestId，再退行号（行号是 cursor 相对的，只在"同一 cursor 重复合成"
          // 这个场景里稳——那正是双注册的情形，够用）。
          // 跨批延续:本批首组与上一批尾组同 requestId → 是同一次模型调用被批界拆开,
          // 身份(anchor/ts)必须沿用上一批已发出的那条 span,重发全量、后写赢。
          const cont =
            groups.length === 0 && partialLlm && entry.requestId && partialLlm.rid === entry.requestId;
          cur = cont
            ? {
                rid,
                anchor: partialLlm.anchor,
                entries: [entry],
                startTs: partialLlm.start_ts ?? null,
                // 续写沿用**首批的**快照:本批 ctx 已滚入了同次调用的前半段输出,
                // 再取当前 ctx 会把自己的 part1 混进 input_local,违反"调用前上下文"
                // 语义(codex 二轮复审中危,纯函数反例属实)。
                ctxSnapshot: null,
                inputLocalOverride: partialLlm.input_local ?? null,
                tsOverride: partialLlm.ts ?? null,
                carriedOutput: partialLlm.output ?? "",
              }
            : {
                rid,
                anchor: entry.uuid ?? entry.requestId ?? `line-${i}`,
                entries: [entry],
                startTs: lastEntryTs,
                ctxSnapshot: ctx,
              };
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
        // 普通工具也走派生（锚 tool_use_id，全局唯一且在 transcript 里就有）：
        // 随机 id 会让"同一批行被合成两遍"变成两条不同键的 span，读侧折不掉。
        const spanId = subAgentId
          ? deriveSpanId(traceId, `tool:${subAgentId}`)
          : deriveSpanId(traceId, `tool_use:${b.tool_use_id}`);

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
    const emittedTs =
      g.tsOverride ?? (duration != null ? g.startTs : first.timestamp) ?? new Date().toISOString();
    const newText = g.entries.map((e) => assistantText(e.message?.content)).filter(Boolean).join("\n");
    const emittedOutput = g.carriedOutput ? `${g.carriedOutput}\n${newText}` : newText;
    g.emittedTs = emittedTs;
    g.emittedOutput = emittedOutput;
    spans.push({
      trace_id: traceId,
      span_id: deriveSpanId(traceId, `llm:${g.anchor}`),
      parent_id: parentId,
      session_id: sessionId,
      kind: "llm",
      name: "anthropic.messages",
      model: msg.model ?? null,
      status: "ok",
      ts: emittedTs,
      duration_ms: duration,
      input: null, // 上报侧恒 null：远端只看 token；完整 prompt 走 input_local 纯本地
      // input_local：该轮模型调用实际看到的上下文（截尾，contentCap 控制长度）。
      // 开关 DBDOG_OBS_STORE_LLM_INPUT=0 可关；只在 spans.jsonl，reportSpans 前剥离。
      ...(storeLlmInput()
        ? { input_local: g.inputLocalOverride !== undefined ? (g.inputLocalOverride ?? "") : capTail(g.ctxSnapshot ?? "") }
        : {}),
      output: cap(emittedOutput),
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

  // 尾组延续信息：只有带真实 requestId 的组才可能被批界拆开（无 requestId 的行各自成组、
  // 行本身不可再分——readNewLines 只消费完整行）。output 截尾防状态膨胀（cap 足够：
  // 上报侧 output 本就 cap）。
  let partialOut = null;
  const tail = groups[groups.length - 1];
  if (tail && tail.entries[0].requestId) {
    partialOut = {
      rid: tail.rid,
      anchor: tail.anchor,
      ts: tail.emittedTs,
      start_ts: tail.startTs ?? null,
      output: cap(tail.emittedOutput ?? ""),
      // 首批快照随延续信息传递(已 capTail ≤ contentCap,状态可控):续批的 input_local
      // 必须仍是"本次调用之前"的上下文,不能取续批时已含 part1 的 ctx
      input_local:
        tail.inputLocalOverride !== undefined
          ? (tail.inputLocalOverride ?? "")
          : capTail(tail.ctxSnapshot ?? ""),
    };
  }

  return { spans, pendingToolUses, lastEntryTs, firstEntryTs, firstUserText, ctxBuf: ctx, partialLlm: partialOut };
}
