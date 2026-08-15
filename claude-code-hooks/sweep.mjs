#!/usr/bin/env node
// sweep — 收尸：补发卡死的 pending span + 清理过期状态文件。
//
// 为什么需要它：Stop/SubagentStop 上报失败时把 span 存进状态文件的 pending_spans
// 等下次重试，但 session 结束后就再没有下一轮触发，永久卡死（2026-08-09 实测一台
// 机器 35 个状态文件中 5 个有堆积、共 737 条从未送达，本地 spans.jsonl 共 3006 条）。
// 子代理必然中招（结束即无下次），主会话是末轮失败就卡死。
//
// 为什么独立成脚本、而不挂在 stop.mjs 里：stop.mjs 开头就因触发门提前返回
// （`!state?.trace_id || state.active === false`），而 triggered 模式下绝大多数会话
// 压根不触发——越是需要收尸的场景越轮不到它跑。本脚本不看触发门，且可手动执行。
//
// 并发安全：只碰 mtime 超过 IDLE 的状态文件。那种文件的会话必已结束、没有写者，
// 读改写不需要加锁。活跃会话的状态文件一律不碰。
//
// 幂等：span_id 固定，服务端 ClickHouse 是 ReplacingMergeTree、ORDER BY
// (trace_id, ts, span_id)，重复补发会被去重——所以宁可重发，绝不因"可能重复"而丢弃。
//
// 用法：node sweep.mjs（SessionStart hook 会 detached 起它，也可手动跑）
import fs from "node:fs";
import path from "node:path";
import { obsDir, spansPath, reportSpans, run } from "./lib.mjs";

const HOUR = 3600_000;
const DAY = 24 * HOUR;

function envMs(name, fallback) {
  const n = Number(process.env[name] ?? "");
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

/** 多久没被写过才算"会话已结束"，可以安全接管。 */
const IDLE_MS = envMs("DBDOG_OBS_SWEEP_IDLE_MS", 2 * HOUR);
/** 已排空的主会话状态文件保留多久。 */
const TTL_MS = envMs("DBDOG_OBS_SWEEP_TTL_MS", 7 * DAY);
/** 子代理状态文件保留多久——子代理不会复活，排空即无保留价值；
 *  且并行子代理一次就留下几十个文件（实测有会话起了 42 个）。 */
const SUB_TTL_MS = envMs("DBDOG_OBS_SWEEP_SUB_TTL_MS", 1 * DAY);
/** 单批补发条数上限（2026-08-14 调 200→50，经验值）：全文 span 的 input/output 各
 *  8K **字符**封顶（UTF-8 字节数可再放大——中文约 3 字节/字符，JSON 转义还会加码），
 *  50 条 ASCII 约 0.8MB、重中文场景约 2.4MB。回填实测 100 条/批（1–2MB）WAN 上 1–2s
 *  完成，50 条 + 10s 预算按此留了数倍余量；但这是典型链路的经验值，不是最坏情况承诺
 *  ——极端慢链路请调 DBDOG_OBS_SWEEP_BATCH / DBDOG_OBS_REPORT_TIMEOUT_MS。
 *  旧组合 200 条骑在 3s 缺省超时上，47 圈巡检实测 3 个积压文件（213/141/24 条）横跨
 *  30+ 个 SessionStart 反复补发不动（一批超时→整体留着→下次原样再撞）。
 *  服务端限 1000 条/5MB 不变。 */
const BATCH = envMs("DBDOG_OBS_SWEEP_BATCH", 50);

// sweep 不在任何交互路径上（SessionStart/SessionEnd detached 起），上报超时缺省放宽到
// 10s 与批量匹配；用户显式配的 DBDOG_OBS_REPORT_TIMEOUT_MS 仍最高优先。3s 缺省是按
// Stop 关键路径定的（lib.mjs reportTimeoutMs），收尸场景照搬它正是排不空的另一半原因。
if (!process.env.DBDOG_OBS_REPORT_TIMEOUT_MS) process.env.DBDOG_OBS_REPORT_TIMEOUT_MS = "10000";

/** 子代理状态文件名形如 <session_id>.<agent_id>.json；主会话是 <session_id>.json。 */
function isSubagentState(fileName) {
  return fileName.slice(0, -".json".length).includes(".");
}

/** span_id → span 全文。懒建：pending 里若全是旧格式全文就不必读 spans.jsonl。 */
function buildSpanIndex() {
  const index = new Map();
  let text;
  try {
    text = fs.readFileSync(spansPath(), "utf8");
  } catch {
    return index; // 没有本地 JSONL 就查不回来，按缺失处理
  }
  for (const line of text.split("\n")) {
    if (!line) continue;
    try {
      const span = JSON.parse(line);
      if (span?.span_id) index.set(span.span_id, span);
    } catch {
      /* 容忍脏行 */
    }
  }
  return index;
}

run(async () => {
  const dir = obsDir();
  let entries;
  try {
    entries = fs.readdirSync(dir);
  } catch {
    return; // 目录还不存在 = 没装或没跑过，无事可做
  }

  // 只认状态文件。spans.jsonl 是真相源，扩展名 .jsonl 天然落选——补发要靠它回捞，
  // 任何情况下都不得删。
  const stateFiles = entries.filter((f) => f.endsWith(".json"));
  const now = Date.now();
  let index = null;

  for (const fileName of stateFiles) {
    const file = path.join(dir, fileName);
    let stat;
    try {
      stat = fs.statSync(file);
    } catch {
      continue;
    }
    const idleMs = now - stat.mtimeMs;
    if (idleMs < IDLE_MS) continue; // 并发保险丝：可能还有写者，不碰

    let state;
    try {
      state = JSON.parse(fs.readFileSync(file, "utf8"));
    } catch {
      continue; // 坏文件不动，留给人看
    }

    const pending = Array.isArray(state.pending_spans) ? state.pending_spans : [];
    if (pending.length) {
      // 新格式存 span_id（状态文件因此从数百 KB 降到几百字节），旧格式直接躺着全文
      const spans = pending
        .map((item) => {
          if (typeof item !== "string") return item;
          if (!index) index = buildSpanIndex();
          return index.get(item) ?? null;
        })
        .filter(Boolean);

      let allSent = true;
      for (let i = 0; i < spans.length; i += BATCH) {
        if (!(await reportSpans(spans.slice(i, i + BATCH)))) {
          allSent = false;
          break; // 一批失败就整体留着下次再来——宁可重发，不可丢
        }
      }
      if (!allSent) continue;

      state.pending_spans = [];
      try {
        fs.writeFileSync(file, JSON.stringify(state));
      } catch {
        /* 写不动就下次再来 */
      }
      continue; // 刚写过，mtime 已刷新，本轮不再考虑删除
    }

    // 已排空 → 到期就删
    const ttl = isSubagentState(fileName) ? SUB_TTL_MS : TTL_MS;
    if (idleMs >= ttl) {
      try {
        fs.unlinkSync(file);
      } catch {
        /* 删不掉就算了，下次再来 */
      }
    }
  }
});
