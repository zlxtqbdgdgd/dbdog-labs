// preflight.mjs —— 两条 loop 开跑前的守门（owner 2026-09-12）。
//
// 「loop 每个用例实施之前，不管是诊断还是判题，检查两个：1、依赖的基础环境是不是 ok
//   （mcp、数据）；2、同步一下代码（plugin），每个用例同步一下。」
//
// ## 为什么是**每条**，不是每轮一次
// 一轮要跑二三十分钟到两小时。开轮时探通了不代表第五条开跑时还通，而中间挂掉的那几条会
// 一路跑到底、产出一份「什么都查不到」的诊断，然后进判题队列——判官看到的是一条像模像样
// 的空轨迹，多半判成「模型没想到查」。这类失效最贵的地方不是浪费预算，是**把环境故障
// 记成了模型的错**。
//
// ## 检查不过就挡住，不跳过
// 岔到 blocked 并记下理由（蓝图 0028）。不改状态跳过的话，环境长期不通只表现为「队列一直
// 不消」，人得去翻 loop 日志才知道为什么，而日志不在页面上。
//
// ## 现在做三样，第四样没做
// 做了：MCP 探活 / plugin 同步 / 现场过期。
// **没做 `no_telemetry`（窗口里一条遥测都查不到）**：它需要先定死「哪种信号算有遥测」
// ——指标？DBM 活动会话？按哪个实例？定错了会把好行挡在门外，而被挡住的行不会自动回来
// （数据族不自愈），代价比漏挡大得多。理由常量已经在册，等口径定了再接上这一处。
import { spawnSync } from "node:child_process";

import { BLOCK_MCP_TOOLSET_MISMATCH, BLOCK_RECOVERABLE, DIAG_BLOCKED, advanceDiagnosis, listDiagnoses } from "./case-diag-client.mjs";

/** `DBDOG_LOOP_EXPECT_TOOLS` 逗号分隔；没配就是空名单（只查非空）。 */
const envTools = () => String(process.env.DBDOG_LOOP_EXPECT_TOOLS ?? "").split(",").map((s) => s.trim()).filter(Boolean);

/** 守门结论。ok=false 时 reason 是 case-diag-client 里那几个常量之一。 */
const pass = () => ({ ok: true });
const block = (reason, detail) => ({ ok: false, reason, detail });

/**
 * MCP 探活：initialize → tools/list，一个来回。
 *
 * ⚠️ 这是**代理检查**，不是考生那条连接本身。考生（headless 会话）走它自己的 MCP 配置
 * （本机回环反代那一份），而这里探的是 `DBDOG_MCP_URL`。两者指向同一个 server 时这道门
 * 有效；配歪了则可能这边绿、考生那边红。所以日志里要如实写探的是哪个地址，别让人以为
 * 探的就是考生用的那条。
 *
 * `DBDOG_MCP_URL` 没配时**不挡**，只告警：这道门是新加的，为一个没配的 env 让在跑的流水线
 * 全线停摆，比漏挡更坏。
 *
 * ## `expectTools`：连上了不等于拿到的是我们要的那套
 * `DBDOG_MCP_URL` 带着 toolsets / skillsets 查询串，**配错了是静默的**——会话照起、跑批照跑、
 * 分数照记，只是考生手上少了半套工具，然后诊断报告写「查不到」。和「悄悄换成便宜模型」是同一类
 * 静默失败；模型那件事已经在 diag-run 开跑第一行印出来了，工具集这件事此前没人查。
 *
 * 名单由调用方给（`--expect-tool` 可重复，或 env `DBDOG_LOOP_EXPECT_TOOLS` 逗号分隔），
 * **这里不内置一份**：该有哪些工具随 toolsets 选择与 dbdog 版本变，钉在这儿就是第二个真相源。
 * 没给名单时只查非空（同上：没配不挡）。
 */
export async function probeMcp({ url = process.env.DBDOG_MCP_URL, bearer = process.env.DBDOG_MCP_BEARER, expectTools = envTools(), timeoutMs = 20_000 } = {}) {
  const target = (url || "").trim();
  if (!target) {
    return { ok: true, skipped: true, detail: "没配 DBDOG_MCP_URL，本轮跳过 MCP 探活（不挡）" };
  }
  let sessionId = "";
  const rpc = async (method, params, id) => {
    const res = await fetch(target, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        ...(bearer ? { authorization: `Bearer ${String(bearer).trim()}` } : {}),
        ...(sessionId ? { "mcp-session-id": sessionId } : {}),
      },
      body: JSON.stringify({ jsonrpc: "2.0", ...(id ? { id } : {}), method, params }),
      signal: AbortSignal.timeout(timeoutMs),
    });
    const sid = res.headers.get("mcp-session-id");
    if (sid) sessionId = sid;
    const text = await res.text();
    if (!res.ok) throw new Error(`HTTP ${res.status} ${method}: ${text.slice(0, 160)}`);
    if (!text.trim()) return null;
    // SSE 帧与裸 JSON 两种都收（与 probe.mjs 同一套解法）。
    const payload = text.includes("data:")
      ? text.split("\n").filter((l) => l.startsWith("data:")).map((l) => l.slice(5).trim()).join("")
      : text;
    const body = JSON.parse(payload);
    if (body.error) throw new Error(`${method}: ${body.error.message ?? JSON.stringify(body.error)}`);
    return body.result;
  };
  try {
    await rpc("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "loop-preflight", version: "0.0.0" } }, 1);
    await rpc("notifications/initialized", {});
    const list = await rpc("tools/list", {}, 2);
    const names = (list?.tools ?? []).map((t) => String(t?.name ?? ""));
    const n = names.length;
    // 连上了但一个工具都没有，等同于没连上：考生拿不到任何东西可查。
    if (n === 0) return { ...block("mcp_unreachable", `${target} 连上了但 tools/list 是空的`), probed: target };
    const want = (expectTools ?? []).map((t) => String(t).trim()).filter(Boolean);
    const missing = want.filter((t) => !names.includes(t));
    if (missing.length) {
      return {
        ...block(BLOCK_MCP_TOOLSET_MISMATCH,
          `${target} 通（${n} 个工具），但点名要的少了 ${missing.length} 个：${missing.join("、")}——多半是查询串里的 toolsets 配歪了`),
        probed: target,
      };
    }
    return { ok: true, detail: `${target} 通，${n} 个工具${want.length ? `（点名的 ${want.length} 个都在）` : ""}`, probed: target };
  } catch (e) {
    return { ...block("mcp_unreachable", `${target}: ${e.message || e}`), probed: target };
  }
}

/**
 * 同步 plugin（考生用的那份代码）。
 *
 * 命令由调用方给（`--sync-cmd` 或 env `DBDOG_LOOP_SYNC_CMD`），**这里不内置一条**：
 * 装机形态来回变过（插件 / 裸 skill 目录），配置目录也因机器而异（~/.claude vs ~/.claude-max），
 * 写死一条命令在这儿，等于把一个会漂的事实钉成第二个真相源。
 *
 * 没配时不挡，只告警——同 MCP 那条的理由。
 */
export function syncPlugin({ cmd = process.env.DBDOG_LOOP_SYNC_CMD, timeoutMs = 120_000 } = {}) {
  const line = (cmd || "").trim();
  if (!line) {
    return { ok: true, skipped: true, detail: "没配 --sync-cmd / DBDOG_LOOP_SYNC_CMD，本轮跳过代码同步（不挡）" };
  }
  const r = spawnSync(line, { shell: true, encoding: "utf8", timeout: timeoutMs });
  if (r.error) return block("plugin_sync_failed", `${line}: ${r.error.message}`);
  if (r.status !== 0) {
    // 末尾几行比开头有用：失败原因通常打在最后。
    const tail = String(r.stderr || r.stdout || "").trim().split("\n").slice(-3).join(" / ");
    return block("plugin_sync_failed", `${line} 退出码 ${r.status}${tail ? `：${tail}` : ""}`);
  }
  return { ok: true, detail: `${line} 跑通` };
}

/**
 * 现场还在不在：`expires_at` 减掉安全余量之后是不是已经过去了。
 *
 * `expires_at` 由复现方随回执推来（他读我们的留存档位、在自己那边减掉他那份余量）。
 * 这里**再判一道**是 owner 2026-09-12 定的：他排期失准时我们不该跟着烧一轮 agent 预算。
 *
 * **取不到就不判**（回 pass），不拿 now 编一个：编出来的过期时刻会把好行挡在门外，
 * 而数据族挡住之后不会自动回来，只能等人点「重新复现」。
 * 老行与老版本 benchmark 推的回执都没有这个值，那是常态不是异常。
 */
export function checkExpiry(row, { bufferHours = 2, now = new Date() } = {}) {
  const raw = row?.expires_at;
  if (!raw) return { ok: true, skipped: true, detail: "这次复现没带过期时刻，不判过期" };
  const at = new Date(raw);
  if (Number.isNaN(at.getTime())) {
    // 解不开也不挡：一个格式坏掉的时刻不该让一个可能还好用的现场作废，但要吵出来。
    return { ok: true, skipped: true, detail: `过期时刻解不开（${raw}），不判过期` };
  }
  const deadline = new Date(at.getTime() - bufferHours * 3600 * 1000);
  if (now >= deadline) {
    return block("data_expired",
      `现场 ${at.toISOString()} 过期，减 ${bufferHours}h 安全余量后的开跑截止是 ${deadline.toISOString()}`);
  }
  return { ok: true, detail: `现场可用到 ${at.toISOString()}（减 ${bufferHours}h 余量）` };
}

/**
 * 一条用例开跑前的完整守门。回第一个不过的那项——**短路**是有意的：
 * MCP 不通时再去跑一次同步只是浪费两分钟，而理由只记得下一个。
 */
export async function preflight(row, { mcpUrl, mcpBearer, syncCmd, bufferHours, now } = {}) {
  const checks = [];
  const mcp = await probeMcp({ url: mcpUrl, bearer: mcpBearer });
  checks.push({ name: "mcp", ...mcp });
  if (!mcp.ok) return { ok: false, reason: mcp.reason, detail: mcp.detail, checks };

  const sync = syncPlugin({ cmd: syncCmd });
  checks.push({ name: "plugin", ...sync });
  if (!sync.ok) return { ok: false, reason: sync.reason, detail: sync.detail, checks };

  const exp = checkExpiry(row, { bufferHours, now });
  checks.push({ name: "expiry", ...exp });
  if (!exp.ok) return { ok: false, reason: exp.reason, detail: exp.detail, checks };

  return { ok: true, checks };
}

/**
 * 一轮开头把**会自己好**那一族的行放回队列（蓝图 0028）。两条 loop 都调这一条，
 * 不各抄一份：解除的判据（捞哪一族、回哪一步、探几次）只该有一处。
 *
 * 只捞环境族。数据族（现场过期 / 窗口里没遥测）好不了——现场已经不存在了，再探一百次
 * 也不会变出来；放回去只会被这一轮再挡一次，页面上那条行在两个态之间来回跳，看的人
 * 以为系统在重试，其实什么都没发生。它们只能靠人在页面上点「重新复现」。
 *
 * **探一次就够**：这一族的成因是全局的（MCP 整个不通、同步整个失败），不逐条探。
 *
 * 两条 loop 同时跑时会抢着解除同一批行——那没关系：advance 带 from 断言，慢的那个拿 409
 * 回 null，这里只是少数一条，不重试也不报错。
 */
export async function resumeBlocked({ mcpUrl, mcpBearer, syncCmd, log = console.error } = {}) {
  let stuck = [];
  try {
    stuck = await listDiagnoses({ statuses: [DIAG_BLOCKED], blockedReasons: BLOCK_RECOVERABLE, limit: 1000 });
  } catch (e) {
    log(`⚠ 捞不出被挡住的行，本轮不做解除：${e.message || e}`);
    return { resumed: 0, stuck: 0 };
  }
  if (stuck.length === 0) return { resumed: 0, stuck: 0 };

  const mcp = await probeMcp({ url: mcpUrl, bearer: mcpBearer });
  const sync = mcp.ok ? syncPlugin({ cmd: syncCmd }) : { ok: false, detail: "MCP 还没通，先不试同步" };
  if (!mcp.ok || !sync.ok) {
    log(`· ${stuck.length} 条仍被挡住（环境还没好）：${mcp.ok ? sync.detail : mcp.detail}`);
    return { resumed: 0, stuck: stuck.length };
  }

  let back = 0;
  for (const d of stuck) {
    // 回哪一步看行上记的 resume_status——挡住时行在 diagnosing / judging，而要回的是对应的
    // pending 态。**不猜**：没记就跳过让人去看，猜错就是「判题失败的行被重新诊断一遍」。
    const to = String(d.resume_status || "");
    if (!to) { log(`⚠ ${d.case_source} 被挡住但没记该回哪一步，跳过`); continue; }
    try {
      if (await advanceDiagnosis({ id: d.id, from: DIAG_BLOCKED, to })) back++;
    } catch (e) {
      log(`⚠ ${d.case_source} 放回队列失败：${e.message || e}`);
    }
  }
  log(`· 环境恢复，放回 ${back}/${stuck.length} 条被挡住的行`);
  return { resumed: back, stuck: stuck.length };
}

export const _internal = { pass, block };
