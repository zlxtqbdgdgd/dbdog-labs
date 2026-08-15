#!/usr/bin/env node
// summary-worker.mjs — 诊断流程总结 detached worker。
// 由 stop.mjs handleMain 在「本 trace span 增长」时 spawn({detached:true}).unref() 起本进程，
// 后台跑（用户零等待）：读本 trace 的 span → 裁剪（Y 方案）→ 调本地大模型 → 组装 workflow
// 总结 span → appendSpans（本地真相源）+ reportSpans（推 server）。
// 重复生成落同一行：span_id 派生固定 + ts 锚 state.started_at（两者都进 ClickHouse 排序键，
// 只固定 span_id 折不掉）→ 后写赢。
// best-effort：env 未配 / 任何失败 → 直接返回，不打扰任何人（run() 兜底吞错、exit 0）。
// 失败留痕（2026-08-14）：本进程 detached + stdio ignore，run() 只写 stderr 等于写进黑洞
// ——45/47 圈巡检没总结、死因（推理模型 thinking 烧光 max_tokens）藏了两天没人知道。
// 现在任何失败在 obsDir/summary-worker.log 追加一行（时间戳 + session + 错误），可诊断、
// 不打扰会话；日志只追加小行，不设轮转（量级 = 每次失败一行）。
// 用法：node summary-worker.mjs <sessionId>
import fs from "node:fs";
import path from "node:path";
import { obsDir, readState, spansPath, appendSpans, reportSpans, deriveSpanId, pendingIds, run, writeState } from "./lib.mjs";
import { trimSpans, buildPrompt, generateSummary, summaryEnv } from "./summary.mjs";

const SUMMARY_KIND = "workflow";
const SUMMARY_NAME = "diagnosis-summary";

/** 失败落一行；日志本身失败就算了（绝不因留痕再抛）。 */
function logFailure(sessionId, err) {
  try {
    fs.appendFileSync(
      path.join(obsDir(), "summary-worker.log"),
      `${new Date().toISOString()} session=${sessionId} ${err?.message ?? err}\n`,
    );
  } catch {
    /* 留不下就留不下 */
  }
}

/** wx 抢锁:3 次×50ms;陈锁(>10 分钟,worker 崩溃残留)接管。抢不到 = 有人在提交。 */
function acquireLock(lockPath) {
  for (let i = 0; i < 3; i++) {
    try {
      fs.writeFileSync(lockPath, JSON.stringify({ pid: process.pid, at: Date.now() }), { flag: "wx" });
      return true;
    } catch {
      try {
        if (Date.now() - fs.statSync(lockPath).mtimeMs > 10 * 60_000) {
          fs.unlinkSync(lockPath);
          continue; // 陈锁已清,立刻重试
        }
      } catch {
        continue; // 对方刚释放,立刻重试
      }
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50); // 活锁短等
    }
  }
  return false;
}

run(async () => {
  const sessionId = process.argv[2];
  if (!sessionId) return;
  try {
    await main(sessionId);
  } catch (err) {
    logFailure(sessionId, err);
  }
});

async function main(sessionId) {
  const state = readState(sessionId);
  if (!state?.trace_id || !state?.root_span_id) return;

  const env = summaryEnv();
  if (!env) return; // 未配 → 不出总结（不影响 trace）

  // 本 trace 的 span（真相源 = spans.jsonl）。一次读同时算两件事：
  // · 去重视图（span_id 后写赢）喂事实表；
  // · 原始行数 = 快照水位。水位必须按**行数**而非去重后 span 数（codex 二轮复审阻断项）：
  //   SessionEnd 的 root 刷新/跨批续写都是同键追加行，去重数不变——完整快照与残缺快照
  //   水位相等的话，旧 worker 仍能后写覆盖。行数只增不减，完整快照恒压过残缺快照。
  let watermark = 0;
  const byId = new Map();
  let text;
  try {
    text = fs.readFileSync(spansPath(), "utf8");
  } catch {
    return; // 没有本地 JSONL 就没有素材
  }
  for (const line of text.split("\n")) {
    if (!line) continue;
    let span;
    try {
      span = JSON.parse(line);
    } catch {
      continue; // 容忍脏行
    }
    if (span?.trace_id !== state.trace_id || !span.span_id) continue;
    watermark++;
    byId.set(span.span_id, span);
  }
  const spans = [...byId.values()];
  if (spans.length === 0) return;

  // 代次校验（codex 复审）：Stop 与 SessionEnd 各 spawn 一个 worker 时，旧快照的那个
  // 可能因 LLM 慢而后写，把完整总结覆盖回残缺版。固定键只保「可折叠」，不保「新的赢」
  // ——写之前按水位比较，矮水位丢弃自己；等水位 = 同一份快照，谁写都等价。
  // 提交段（检查→写水位→落盘）由 wx 文件锁互斥（codex 三轮核对：读—比—写—追加要原子）：
  // 锁只罩纯本地操作（毫秒级持锁，LLM 调用与上报都在锁外），竞不到锁 = 有并发 worker
  // 正在提交，丢弃自己的结果并留痕；陈锁（worker 崩溃残留，>10 分钟）可接管。
  // 两个标记文件都取 *.json 后缀：sweep 当子代理状态走 TTL 自然清理。
  const genPath = path.join(obsDir(), `${state.trace_id}.summary-gen.json`);
  const lockPath = path.join(obsDir(), `${state.trace_id}.summary-lock.json`);

  // 裁剪 → 提示词 → 本地大模型（失败抛 → run() 吞）
  const factTable = trimSpans(spans);
  const result = await generateSummary(buildPrompt(factTable), env);

  // 组装总结 span（固定 span_id → 后写赢，重复生成覆盖同一行）
  const summarySpan = {
    trace_id: state.trace_id,
    span_id: deriveSpanId(state.trace_id, "diag-summary"),
    parent_id: state.root_span_id,
    session_id: state.session_id ?? sessionId,
    kind: SUMMARY_KIND,
    name: SUMMARY_NAME,
    model: null,
    status: "ok",
    // ts 锚在 trace 起点，不能取 new Date()：总结会在每个"有新工具调用"的 Stop 之后重算，
    // 而 ClickHouse 那张表排序键是 (trace_id, ts, span_id)——ts 一变就是新行、FINAL 折不掉，
    // 平台上会堆好几条总结，控制台 findSummarySpan 按 ts 序 .find() 到的还是最早那条（过期）。
    // 固定 span_id 只解决一半，ts 也必须稳定。缺 started_at 的老状态退回墙上时钟。
    ts: state.started_at ?? new Date().toISOString(),
    duration_ms: null,
    input: null,
    output: result.text,
    intent: undefined,
    tokens_input: null,
    tokens_output: null,
    tokens_cache_read: null,
    tokens_cache_creation: null,
    tags: {
      trace_source: "client",
      summary_model: result.model,
      ...(result.tokens_input != null ? { summary_tokens_in: String(result.tokens_input) } : {}),
      ...(result.tokens_output != null ? { summary_tokens_out: String(result.tokens_output) } : {}),
      ...(state.ml_app ? { ml_app: state.ml_app } : {}),
    },
  };

  if (!acquireLock(lockPath)) {
    logFailure(sessionId, `summary commit lock busy（水位 ${watermark}），丢弃本次结果`);
    return;
  }
  let committed = false;
  try {
    let existing = null;
    try {
      existing = JSON.parse(fs.readFileSync(genPath, "utf8"));
    } catch {
      /* 没有标记 = 首个写者 */
    }
    if (existing && Number(existing.watermark) > watermark) {
      logFailure(sessionId, `stale snapshot dropped: watermark ${watermark} < ${existing.watermark}`);
      return;
    }
    try {
      fs.writeFileSync(genPath, JSON.stringify({ watermark }));
    } catch {
      /* 标记写不动就退回后写赢,不阻塞总结 */
    }


    appendSpans([summarySpan]); // 本地真相源先落（在锁内:与代次标记同段原子）
    committed = true;
  } finally {
    try {
      fs.unlinkSync(lockPath);
    } catch {
      /* 锁没了就没了 */
    }
  }
  if (!committed) return;
  // 上报在锁外:3s 网络超时不该占住提交段
  if (!(await reportSpans([summarySpan]))) {
    // 送达失败（codex 复审）：一次性会话之后没有下一轮重试,不落 pending 平台就永久没有。
    // pending 落 worker **专属 sidecar** <session>.summary.json（statePath 的 "summary"
    // 假 agent 位）——绝不写主状态：持旧快照、正在等上报的 Stop/SessionEnd 随后整文件
    // 覆盖会把它抹掉（codex 二轮复审阻断项:主状态必须保持单写者）。sweep 扫所有状态
    // 文件,sidecar 同样被补发、排空后按子代理 TTL(1 天)自然清理。
    try {
      // 按 trace 隔离(codex 三轮核对:同 session 多 trace 的 worker 共写一个 sidecar
      // 仍是读改写竞态)。同 trace 只有锁的赢家能走到这里 → 每文件单写者成立。
      const sideKey = `summary-${state.trace_id.slice(0, 16)}`;
      const side = readState(sessionId, sideKey) ?? {};
      side.trace_id = state.trace_id;
      side.pending_spans = [...pendingIds(side.pending_spans), summarySpan.span_id];
      writeState(sessionId, side, sideKey);
    } catch {
      /* 状态写不动,至少还有日志与本地 JSONL */
    }
    logFailure(sessionId, "summary span report failed（已落本地与 sidecar pending，待 sweep 补发）");
  }
}
