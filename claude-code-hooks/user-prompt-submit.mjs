#!/usr/bin/env node
// UserPromptSubmit — trace 铸造点（课题 §3：mint 归"编排循环边界"，在 Claude Code
// 里就是"用户发了一条新消息"这个事件；一条用户消息 = 一条 trace，session 归组）。
// root_span_id 从 trace_id 前 8 字节确定性派生——PreToolUse 无需协调即可算出 parent。
// 不向 stdout 输出任何内容（UserPromptSubmit 的 stdout 会被注入上下文）。
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { readStdinJson, readState, writeState, pendingIds, run } from "./lib.mjs";

run(async () => {
  const input = await readStdinJson();
  const sessionId = input.session_id;
  if (!sessionId) return;

  // —— 触发门（DBDOG_OBS_MODE，2026-07-11 用户定：触发了才建 trace，不触发零足迹）——
  //   always     每条消息都记（诊断专用目录用，如 dbdog-test）
  //   triggered  默认：prompt 以触发词开头才记（DBDOG_OBS_TRIGGER，默认「诊断:」；
  //              另恒收 "diag:" 小写前缀作英文触发）
  //   off        彻底关闭
  // 未触发时必须把既有 state 置 inactive——否则本轮的工具调用会被 PreToolUse 注入
  // 上一条 trace 的 id、Stop 会把本轮的模型消息合成进上一条 trace（错误归属）。
  const mode = (process.env.DBDOG_OBS_MODE?.trim() || "triggered").toLowerCase();
  const promptText = (typeof input.prompt === "string" ? input.prompt : "").trimStart();
  const prev = readState(sessionId);

  /** transcript 当前大小 = 本次交界的字节位置（新 trace 的起点 / 旧 trace 的终点）。 */
  let boundary = 0;
  try {
    boundary = fs.statSync(input.transcript_path).size;
  } catch {
    // 新 session 的 transcript 可能尚未落盘 → 从 0 起
  }

  /**
   * 上一条 trace 交界时未落盘的尾巴。
   * Stop 读 transcript 时，本轮收尾那几行（通常正是产出结论的 assistant 行）往往还没落盘；
   * 而这里铸新 trace 会把游标跳到 boundary，那几行就永久没人合成——实测每条 trace 恒定丢
   * 最后一轮的 llm span。把区间连同配对上下文交给 stop.mjs 的 flushCarry 按**旧** trace_id 补。
   * 上界取交界时刻的大小，所以绝不会把新一轮的内容错记到旧 trace 上。
   */
  const carry =
    prev?.trace_id && prev.active !== false && boundary > (prev.cursor ?? 0)
      ? {
          trace_id: prev.trace_id,
          root_span_id: prev.root_span_id,
          session_id: prev.session_id ?? sessionId,
          ml_app: prev.ml_app,
          from: prev.cursor ?? 0,
          to: boundary,
          transcript_path: prev.transcript_path ?? input.transcript_path ?? null,
          pending_tool_uses: prev.pending_tool_uses ?? {},
          last_entry_ts: prev.last_entry_ts ?? null,
          // 尾组延续信息一并交给收尾批:交界拆开的 requestId 组要按旧身份重发(同键同 ts)
          partial_llm: prev.partial_llm ?? null,
        }
      : null;

  // —— 注入轮：不是新提问，一律原地返回（2026-08-12）——
  // 上游 Claude Code 的 Agent 工具是即时返回的后台派发，子代理跑完靠往会话里注入一轮
  // `<task-notification>` 通知。那一轮同样走 UserPromptSubmit，prompt 自然不带触发词，
  // 落到下面的未触发分支就把 trace 置成 active:false——而它其实正是**本条 trace** 里
  // 后台子代理的收尾，此后所有 SubagentStop 都被 run() 的门挡掉，子代理整棵子树消失。
  // 实测一条 trace 起 4 个子代理只活下来 1 个（唯一那个的 SubagentStop 早于第一条通知）。
  // 判据：宿主给了 origin.kind 就用它；没给则认 prompt 的 `<task-notification>` 前缀
  // （实测主 transcript 里该轮 origin.kind=task-notification、正文以此开头）。
  // 已知残留：用户真发了一条不带触发词的新提问、而后台子代理还没收尾时，那些子代理仍会
  // 被丢——那种情形下 state 已该归属新一轮，硬留会造成错误归属，另案处理。
  const injectedKind = typeof input.origin?.kind === "string" ? input.origin.kind : "";
  if (injectedKind === "task-notification" || promptText.startsWith("<task-notification>")) return;
  const trigger = process.env.DBDOG_OBS_TRIGGER?.trim() || "诊断:";
  // 冒号全半角归一（2026-07-11 用户提出）：中文输入法默认全角「：」，「诊断：」也必须触发；
  // 自定义触发词同样归一后比较，两种冒号都收。
  const norm = (s) => s.replace(/：/g, ":");
  const triggered =
    mode === "always" ||
    (mode === "triggered" &&
      (norm(promptText).startsWith(norm(trigger)) || norm(promptText).toLowerCase().startsWith("diag:")));
  if (!triggered) {
    // 停用也是一次交界：本轮换了话题，旧 trace 的尾巴同样要收（stop.mjs 允许 inactive 时只收尾）。
    if (prev && prev.active !== false) {
      writeState(sessionId, { ...prev, active: false, ...(carry ? { carry } : {}) });
    }
    return;
  }

  // ml_app（DD llmobs 一等维度的 dbdog 对应物）：区分「哪个应用/项目的 trace」——
  // 复盘按它过滤，编码会话和真诊断才分得开。env 显式配 > 项目目录名兜底。
  const mlApp =
    process.env.DBDOG_OBS_ML_APP?.trim() || path.basename(input.cwd || process.cwd()) || "unknown";

  const traceId = crypto.randomBytes(16).toString("hex"); // 32 hex（W3C trace-id 形状）
  const rootSpanId = traceId.slice(0, 16); // 16 hex，确定性派生

  writeState(sessionId, {
    active: true,
    trace_id: traceId,
    root_span_id: rootSpanId,
    session_id: sessionId,
    ml_app: mlApp,
    prompt: typeof input.prompt === "string" ? input.prompt : "",
    started_at: new Date().toISOString(),
    transcript_path: input.transcript_path ?? null,
    // 游标从交界处（当前文件末尾）起——Stop 只合成本条 trace 的新增轮次；交界之前若还有
    // 未读的尾巴，已交给 carry 按旧 trace_id 收尾，既不丢也不会错记到新 trace 上。
    cursor: boundary,
    root_emitted: false,
    ...(carry ? { carry } : {}),
    // 上一轮没送达的 span 必须带过来：这里写的是全新 state 对象，不显式继承就等于
    // 把"它们没送达"这件事一起抹掉——之后连 sweep 也无从救起（实测有一条 trace
    // 因此永久缺了 109 条 span，且不在任何状态文件里）。
    pending_spans: pendingIds(prev?.pending_spans),
  });
});
