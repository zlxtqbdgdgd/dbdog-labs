#!/usr/bin/env node
// SessionEnd — 会话直接结束的收尾（2026-08-14，47 圈 headless 巡检实测定案）。
//
// 成因：carry 机制（v0.4.4）只在「下一次 UserPromptSubmit」铸造/停用时记账；
// 一次性会话（claude -p）或直接关窗没有下一次——Stop 读 transcript 时本轮收尾那几行
// （正是产出结论的 assistant 行）还没落盘，[cursor, EOF] 永久没人合成。
// 实测 47 圈巡检 46 圈丢尾部 llm span（每圈 1–6 条）；更狠的是会话退出时仍在跑的
// 子代理连 SubagentStop 都不会触发，整棵子树消失（单圈实测丢 241 条）。
//
// 收尾三件事（全部幂等：span_id/ts 皆确定性派生，重入只推游标不重发）：
//   ① 先收 carry（换过话题遗留的旧 trace 尾巴，与 stop.mjs 同一段逻辑）；
//   ② 主线补 [cursor, EOF]——SessionEnd 时 transcript 已写完，读到哪算哪；
//      并确保/刷新 root（codex 复审阻断项两连：Stop 从未发生的会话（API 错误/中断）
//      root 缺失，整树是孤儿；尾部结论只有进了 root output，重算总结的事实表才吃得到
//      ——trimSpans 只读 agent/tool 证据，llm output 是被裁掉的）；
//   ③ 子代理 transcript 挨个补到 EOF：有状态文件的续 cursor 且只认归属当前 trace 的
//      （SubagentStop 已把 trace_id 固化进子状态）；没状态文件的看 transcript mtime——
//      trace 开始前就停笔的属于旧话题，不得错挂进当前 trace（codex 复审阻断项）。
//      一次都没被 SubagentStop 处理过的（in-flight 退出）整棵合成，agent_type 从
//      agent-<id>.meta.json 读（SubagentStop 的 input.agent_type 此刻已无从拿）。
//
// 触发门与 Stop 对齐：state.active === false 时只收 carry（②③ 不做——停用后的
// 行不属于任何 trace，子代理丢弃是 user-prompt-submit.mjs 已记档的既有语义）。
//
// 上报分批（每批 ≤100）：收尾批可能有几百条（in-flight 子代理整棵），单发大包会
// 骑在 3s 超时上；失败的照旧记 pending_spans，留给下一次 sweep。
//
// ④ 收尾出了新 span 就再触发一次诊断总结（detached，同 stop.mjs）——此时尾部结论
//    span 已补齐，总结吃到的是完整 trace。Stop 时刻的 spawn 保持不动：两个 worker
//    产同键同 ts 的 workflow span，读侧后写赢，互不打架。
import fs from "node:fs";
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  appendSpans,
  cap,
  deriveSpanId,
  lookupSpans,
  obsDir,
  pendingIds,
  readState,
  readStdinJson,
  reportSpans,
  run,
  writeState,
} from "./lib.mjs";
import { PENDING_TOOL_USE_MAX, msBetween, readNewLines, synthesize } from "./synthesize.mjs";
import { summaryEnv } from "./summary.mjs";

/** 诊断流程总结 detached worker（与 stop.mjs 用同一个）。 */
const WORKER = path.join(path.dirname(fileURLToPath(import.meta.url)), "summary-worker.mjs");

/** sweep 收尸脚本（与 session-start.mjs 用同一个）。 */
const SWEEP = path.join(path.dirname(fileURLToPath(import.meta.url)), "sweep.mjs");

/** 单批上报条数上限（对齐 sweep 的量级；服务端限 1000 条/5MB，留足余量）。 */
const BATCH = 100;

/** summary-worker.log 同款留痕：detached + ignore 的黑洞里不能静默吞。 */
function logNote(sessionId, msg) {
  try {
    fs.appendFileSync(
      path.join(obsDir(), "summary-worker.log"),
      `${new Date().toISOString()} session=${sessionId} ${msg}\n`,
    );
  } catch {
    /* 留不下就留不下 */
  }
}

/** detached spawn 防崩：运行期失败（ENOENT 类）走异步 error 事件，try/catch 接不住。 */
function spawnDetached(args, sessionId, note) {
  try {
    const child = spawn(process.execPath, args, { detached: true, stdio: "ignore" });
    child.once("error", (err) => logNote(sessionId, `${note} spawn error: ${err?.message ?? err}`));
    child.unref();
  } catch (err) {
    logNote(sessionId, `${note} spawn failed: ${err?.message ?? err}`);
  }
}

/** 倒序找最后一段非空助手文本（近似 last_assistant_message）。 */
function lastAssistantText(lines) {
  for (let i = lines.length - 1; i >= 0; i--) {
    try {
      const e = JSON.parse(lines[i]);
      if (e?.type === "assistant" && Array.isArray(e.message?.content)) {
        const text = e.message.content
          .map((b) => (b?.type === "text" ? b.text : ""))
          .filter(Boolean)
          .join("\n");
        if (text) return text;
      }
    } catch {
      /* 脏行跳过 */
    }
  }
  return "";
}

/** 落盘 + 分批上报；返回未送达的 span_id 列表（含 carriedOverIds 里重发失败的）。 */
async function emitBatched(spans, carriedOverIds) {
  appendSpans(spans);
  const batch = [...lookupSpans(carriedOverIds), ...spans];
  const failed = [];
  for (let i = 0; i < batch.length; i += BATCH) {
    const part = batch.slice(i, i + BATCH);
    if (!(await reportSpans(part))) failed.push(...part.map((s) => s.span_id));
  }
  return failed;
}

/** carry 收尾：与 stop.mjs flushCarry 同构（SessionEnd 也可能是交界后的第一个事件）。 */
async function flushCarry(input, state) {
  const c = state.carry;
  if (!c) return false;
  delete state.carry;
  const transcript = c.transcript_path ?? input.transcript_path ?? state.transcript_path;
  if (!c.trace_id || !transcript || !(c.to > c.from)) return true;
  let lines;
  try {
    ({ lines } = readNewLines(transcript, c.from, c.to));
  } catch {
    return true; // transcript 已被清理——没得补，别打断收尾
  }
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
    ctxBuf: "",
    partialLlm: c.partial_llm ?? null,
  });
  if (!spans.length) return true;
  const pending = await emitBatched(spans, []);
  state.pending_spans = [...pendingIds(state.pending_spans), ...pending];
  return true;
}

/** 主线尾巴：[cursor, EOF]，与 handleMain 同粒度；并确保/刷新 root——
 *  · Stop 从未发生（API 错误/中断）→ root 缺失，整树在读侧是孤儿，必须补；
 *  · 尾部有新结论文本 → 刷新 root output（同 span_id、ts 恒锚 started_at → 后写赢），
 *    重算总结的事实表读的正是 root output（trimSpans 裁掉 llm output）；
 *  · 尾部没有新文本且 root 已发 → 不动（空串覆盖会把 Stop 落定的结论抹掉）。 */
async function flushMainTail(input, state) {
  const transcript = input.transcript_path ?? state.transcript_path;
  if (!transcript) return 0;
  let lines = [];
  let nextCursor = state.cursor ?? 0;
  try {
    ({ lines, nextCursor } = readNewLines(transcript, state.cursor ?? 0));
  } catch {
    return 0; // transcript 不在了，无尾可收、root 也无从考证
  }
  if (!lines.length && state.root_emitted) return 0;

  let spans = [];
  let pendingToolUses = new Map(Object.entries(state.pending_tool_uses ?? {}));
  let lastEntryTs = state.last_entry_ts ?? null;
  let ctxBuf = state.ctx_buf ?? "";
  let partialLlm = state.partial_llm ?? null;
  if (lines.length) {
    ({ spans, pendingToolUses, lastEntryTs, ctxBuf, partialLlm } = synthesize({
      lines,
      traceId: state.trace_id,
      sessionId: state.session_id,
      parentId: state.root_span_id,
      mlApp: state.ml_app,
      pendingToolUses,
      lastEntryTs,
      agent: null,
      ctxBuf,
      partialLlm,
    }));
  }

  // 尾部结论:优先取本批最后一条 llm span 的 output——它经 partial_llm 续写合并,
  // 同 requestId 多行的结论是**全量**;只取最后一行 JSONL 会把前半段丢掉
  // (codex 二轮复审高危)。没有 llm span(无 usage 行)再退回逐行扫描。
  const lastLlm = spans.filter((s) => s.kind === "llm").pop();
  const lastText = (lastLlm && lastLlm.output) || lastAssistantText(lines);
  if (!state.root_emitted || lastText) {
    spans.push({
      trace_id: state.trace_id,
      span_id: state.root_span_id,
      parent_id: null,
      session_id: state.session_id,
      kind: "agent",
      name: "claude-code.task",
      model: null,
      status: "ok",
      ts: state.started_at, // 与 Stop 的 root 同键同 ts，后写赢
      duration_ms: msBetween(state.started_at, lastEntryTs),
      input: cap(state.prompt ?? ""),
      output: cap(lastText),
      tokens_input: null,
      tokens_output: null,
      tokens_cache_read: null,
      tokens_cache_creation: null,
      tags: { trace_source: "client", ...(state.ml_app ? { ml_app: state.ml_app } : {}) },
    });
    state.root_emitted = true;
  }
  if (!spans.length) return 0;

  const pending = await emitBatched(spans, pendingIds(state.pending_spans));
  state.cursor = nextCursor;
  state.pending_spans = pending;
  state.last_entry_ts = lastEntryTs;
  state.ctx_buf = ctxBuf;
  state.partial_llm = partialLlm ?? null;
  state.pending_tool_uses = Object.fromEntries(
    [...(pendingToolUses instanceof Map ? pendingToolUses.entries() : Object.entries(pendingToolUses))].slice(-PENDING_TOOL_USE_MAX),
  );
  return spans.length;
}

/**
 * 子代理收尾：<transcript 同目录>/<session_id>/subagents/agent-*.jsonl 挨个补到 EOF。
 * 与 handleSubagent 的差别只有两处：agent_type 从 meta.json 读；
 * output 没有 input.last_assistant_message 可用，取子代理 transcript 里最后一段
 * 助手文本作近似（agent span 同 span_id 重发、读侧后写赢，SubagentStop 发过的不受损）。
 */
async function flushSubagents(input, state) {
  const transcript = input.transcript_path ?? state.transcript_path;
  const sessionId = input.session_id;
  if (!transcript || !sessionId) return 0;
  const subDir = path.join(path.dirname(transcript), sessionId, "subagents");
  let files;
  try {
    files = fs.readdirSync(subDir).filter((f) => f.startsWith("agent-") && f.endsWith(".jsonl"));
  } catch {
    return 0; // 没起过子代理
  }
  let flushed = 0;
  const traceStartMs = Date.parse(state.started_at ?? "");
  for (const f of files) {
    const agentId = f.slice("agent-".length, -".jsonl".length);
    const at = path.join(subDir, f);
    const sub = readState(sessionId, agentId) ?? {};
    // trace 归属守卫（codex 复审阻断项）：
    // · 有状态且记了别的 trace → 是上一条 trace 的子代理，跳过（错挂比丢尾更糟）；
    // · 无状态（SubagentStop 从没处理过）→ 看 transcript mtime：trace 开始前就停笔的
    //   属于旧话题/未触发轮，不属于本 trace。仍在写的 in-flight 子代理 mtime 必然更新，
    //   照收——与 SubagentStop 把 in-flight 归到当前 trace 的既有语义一致。
    if (sub.trace_id && sub.trace_id !== state.trace_id) continue;
    if (!sub.trace_id) {
      let mtimeMs;
      try {
        mtimeMs = fs.statSync(at).mtimeMs;
      } catch {
        continue;
      }
      if (Number.isFinite(traceStartMs) && mtimeMs < traceStartMs) continue;
    }
    let lines, nextCursor;
    try {
      ({ lines, nextCursor } = readNewLines(at, sub.cursor ?? 0));
    } catch {
      continue;
    }
    if (!lines.length) continue;

    let agentType = null;
    try {
      agentType = JSON.parse(fs.readFileSync(at.slice(0, -".jsonl".length) + ".meta.json", "utf8"))
        .agentType ?? null;
    } catch {
      /* 没 meta 就不打 agent_type */
    }

    const selfSpanId = deriveSpanId(state.trace_id, agentId);
    const parentToolSpanId = deriveSpanId(state.trace_id, `tool:${agentId}`);
    const { spans, pendingToolUses, lastEntryTs, firstEntryTs, firstUserText, ctxBuf, partialLlm } = synthesize({
      lines,
      traceId: state.trace_id,
      sessionId: state.session_id ?? sessionId,
      parentId: selfSpanId,
      mlApp: state.ml_app,
      pendingToolUses: new Map(Object.entries(sub.pending_tool_uses ?? {})),
      lastEntryTs: sub.last_entry_ts ?? null,
      agent: { id: agentId, type: agentType },
      ctxBuf: sub.ctx_buf ?? "",
      partialLlm: sub.partial_llm ?? null,
    });

    const startedAt = sub.started_at ?? firstEntryTs;
    const prompt = sub.prompt ?? firstUserText;
    // 最后一段助手文本 = last_assistant_message 的近似。
    // 覆盖守卫（codex 复审）：SubagentStop 已发过 agent span（sub.started_at 在）而尾巴
    // 没有任何新文本 → 不重发。近似空串按"后写赢"会把权威 output 抹掉。
    const lastText = lastAssistantText(lines);
    if (startedAt && (!sub.started_at || lastText)) {
      spans.push({
        trace_id: state.trace_id,
        span_id: selfSpanId,
        parent_id: parentToolSpanId,
        session_id: state.session_id ?? sessionId,
        kind: "agent",
        name: "claude-code.subagent",
        model: null,
        status: "ok",
        ts: startedAt,
        duration_ms: msBetween(startedAt, lastEntryTs),
        input: cap(prompt ?? ""),
        output: cap(lastText),
        tokens_input: null,
        tokens_output: null,
        tokens_cache_read: null,
        tokens_cache_creation: null,
        tags: {
          sidechain: "1",
          agent_id: agentId,
          ...(agentType ? { agent_type: agentType } : {}),
          ...(state.ml_app ? { ml_app: state.ml_app } : {}),
        },
      });
    }

    const pending = await emitBatched(spans, pendingIds(sub.pending_spans));
    flushed += spans.length;
    writeState(
      sessionId,
      {
        cursor: nextCursor,
        pending_spans: pending,
        last_entry_ts: lastEntryTs,
        started_at: startedAt ?? null,
        prompt: prompt ?? null,
        pending_tool_uses: Object.fromEntries([...pendingToolUses.entries()].slice(-PENDING_TOOL_USE_MAX)),
        ctx_buf: ctxBuf,
        trace_id: state.trace_id,
        partial_llm: partialLlm ?? null,
      },
      agentId,
    );
  }
  return flushed;
}

/** trace 相关收尾（有 trace 状态才有事做;sweep 排空独立于此,见 run()）。 */
async function handleTraceTail(input, state) {
  const flushed = await flushCarry(input, state);
  if (state.active === false) {
    // 停用后的行不属于任何 trace；子代理丢弃是既有语义（见 user-prompt-submit.mjs）
    if (flushed) writeState(input.session_id, state);
    return;
  }
  const flushedMain = await flushMainTail(input, state);
  const flushedSub = await flushSubagents(input, state);
  writeState(input.session_id, state);

  // 收尾出了新 span → 总结重算一次（吃到补齐后的完整 trace）。detached：SessionEnd 的
  // 30s 超时罩不住 LLM 调用，且 worker 失败自己会在 summary-worker.log 留痕。
  // 新旧 worker 竞态由 worker 侧的代次校验兜底（summary-worker.mjs，水位=原始行数）。
  if (flushedMain + flushedSub > 0 && summaryEnv()) {
    spawnDetached([WORKER, input.session_id], input.session_id, "summary worker");
  }
}

run(async () => {
  const input = await readStdinJson();
  const state = readState(input.session_id);
  try {
    if (state?.trace_id) await handleTraceTail(input, state);
  } finally {
    // 排空积压与"本会话有没有 trace"无关（codex 二轮复审高危:门控遗漏）——
    // 未触发观测的会话退出同样是排空时机。一串 headless 会话跑完之后再无
    // SessionStart，旧会话卡死的 pending 从此没人补发——47 圈巡检 B 类送达丢失
    // （168 条横跨 30+ 小时）正是这条触发链断掉。sweep 只碰 idle>2h 的旧状态文件，
    // 与本会话刚写的文件天然无竞争（本会话自己的 pending 留给之后的 sweep）。
    spawnDetached([SWEEP], input.session_id ?? "-", "sweep");
  }
});
