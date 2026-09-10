// agent-cli.mjs — headless agent：Claude CLI | Codex CLI | Cursor Agent CLI（diagnose）。
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";
import { spawn } from "node:child_process";
import { agentBin, agentCwd, resolveAgentKind } from "./agent-kind.mjs";

/** tool_result.content 可能是字符串或 [{type:text,text}] 块数组 → 拍平成字符串。 */
function flattenResultContent(content) {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content.map((b) => (typeof b === "string" ? b : b?.text ?? (b?.type === "text" ? b.text : JSON.stringify(b)))).join("\n");
  }
  if (content == null) return "";
  return typeof content === "object" ? JSON.stringify(content) : String(content);
}

/**
 * Claude CLI stream-json（NDJSON）增量事件处理器。逐行喂入；tool_use/tool_result 按到达
 * 时间戳，duration_ms = result 到达 − use 发起（真实墙钟）。
 * → { prose, toolCalls, sessionId, usage, costUsd, numTurns }。
 * sessionId 供 llmobs runner 回捞 hooks 状态文件（trace_id）；usage/cost 供确定性指标。
 */
export function makeStreamCollector({ captureTools, onInit } = {}) {
  let prose = "";
  let sessionId = "";
  let usage = null;
  let costUsd = null;
  let numTurns = null;
  const textParts = [];
  const pending = new Map(); // tool_use_id → { tool, args, ts, t0 }
  const toolCalls = [];

  function onLine(line) {
    let ev;
    try { ev = JSON.parse(line); } catch { return; }
    if (!sessionId && typeof ev.session_id === "string") sessionId = ev.session_id;
    // 首行 system/init 带 mcp_servers[].status——工具连没连上在这儿就知道，调用方据此决定还跑不跑。
    if (ev.type === "system" && ev.subtype === "init" && typeof onInit === "function") onInit(ev);
    if (ev.type === "assistant" && ev.message?.content) {
      for (const blk of ev.message.content) {
        if (blk.type === "text" && blk.text) textParts.push(blk.text);
        else if (captureTools && blk.type === "tool_use") {
          pending.set(blk.id, { tool: blk.name, args: blk.input ?? null, ts: new Date().toISOString(), t0: Date.now() });
        }
      }
    } else if (ev.type === "user" && ev.message?.content && captureTools) {
      for (const blk of ev.message.content) {
        if (blk.type !== "tool_result") continue;
        const u = pending.get(blk.tool_use_id);
        if (!u) continue;
        pending.delete(blk.tool_use_id);
        const output = flattenResultContent(blk.content);
        toolCalls.push({
          tool: u.tool,
          args: u.args,
          output,
          output_len: output.length,
          duration_ms: Math.max(0, Date.now() - u.t0),
          ts: u.ts,
          outcome: blk.is_error ? "error" : undefined,
        });
      }
    } else if (ev.type === "result") {
      if (typeof ev.result === "string") prose = ev.result;
      if (ev.usage && typeof ev.usage === "object") usage = ev.usage;
      if (typeof ev.total_cost_usd === "number") costUsd = ev.total_cost_usd;
      if (typeof ev.num_turns === "number") numTurns = ev.num_turns;
    }
  }

  function finish() {
    // 未配到 result 的 tool_use（被截断等）也补一条
    if (captureTools) {
      for (const u of pending.values()) {
        toolCalls.push({ tool: u.tool, args: u.args, output: "", output_len: 0, duration_ms: 0, ts: u.ts });
      }
    }
    if (!prose) prose = textParts.join("\n").trim();
    // round-10 H3：CLI 收尾若被簿记类短语占据（如 auto-memory 的「记忆已更新」，001-DD 实证 prose 仅 150B），
    // RCA 正文其实在中途 assistant 消息里 → 兜底取最长正文段，避免报告 §1 空壳。
    const longest = textParts.reduce((a, b) => (b.trim().length > a.trim().length ? b : a), "");
    if (prose.length < 300 && longest.trim().length > prose.length) prose = longest.trim();
    return { prose, toolCalls, sessionId, usage, costUsd, numTurns };
  }

  return { onLine, finish };
}

function runClaude({ prompt, model, mcpConfigPath, cwd, captureTools, extraArgs, extraEnv, timeoutMs }) {
  return new Promise((resolve, reject) => {
    const bin = agentBin();
    // 只投喂用户原话（--print）+ MCP：与真实产品 session 完全一致，不注入任何 harness 话术。
    // 一切引导（skill 发现、工具用法）本就在 MCP 的 SERVER_INSTRUCTIONS 上，由后端出口负责。
    const args = [
      "--print", prompt,
      "--dangerously-skip-permissions",
      "--output-format", "stream-json", "--verbose",
    ];
    if (model) args.push("--model", model);
    if (mcpConfigPath) {
      args.push("--strict-mcp-config", "--mcp-config", mcpConfigPath);
    }

    // round-11 H2：操作者全局 skills/hooks 泄入盲诊会话（103-DD 误触发 eval-ln-* skill、
    // 202-dbdog 引用不存在文件）。E2E_ISOLATE=1 三闸并下：禁本地 skill 面、禁 hooks、
    // 不加载 user 级 settings。MCP 侧 skill 指南（dbdog SERVER_INSTRUCTIONS / DD 的
    // list/load_datadog_skills 工具）走 MCP 协议，不受影响；OAuth/keychain 登录态保留
    // （--bare 才会切成仅 ANTHROPIC_API_KEY，故不用 --bare）。
    if (process.env.E2E_ISOLATE === "1") {
      args.push(
        "--disable-slash-commands",
        "--settings", '{"disableAllHooks":true}',
        "--setting-sources", "project",
      );
    }
    // llmobs runner 等调用方的追加参数（如 --settings 内联 hooks 配置）——放在 E2E_ISOLATE
    // 之后，调用方可覆盖。extraEnv 同理（如 DBDOG_OBS_MODE/DBDOG_OBS_DIR）。
    if (Array.isArray(extraArgs) && extraArgs.length) args.push(...extraArgs);

    // round-10 H1：CLI 新版自带 auto-memory，54 个盲诊断 session 共用 /tmp cwd → 跨 case/跨栈共享
    // 「答案本」（dbdog 13/27、DD 25/27 引用，盲测效度受损）。两层隔离：
    // ① 官方开关硬禁（docs/en/memory: CLAUDE_CODE_DISABLE_AUTO_MEMORY=1，不建/不读 memory 文件）；
    // ② 每 session 一次性 cwd（cwd 键控的项目态互不可见，也消除 5 worker 竞写同一文件的 Edit 冲突）。
    const sessionCwd = cwd || fs.mkdtempSync(path.join(os.tmpdir(), "e2e-claude-"));
    const ownsCwd = !cwd;
    const env = { ...process.env, CLAUDE_CODE_DISABLE_AUTO_MEMORY: "1", ...(extraEnv || {}) };

    const errChunks = [];
    const p = spawn(bin, args, { cwd: sessionCwd, env, stdio: ["ignore", "pipe", "pipe"] });
    let timedOut = false;
    // MCP 连不上就立刻终止，不让 agent 盲跑：2026-09-09 P0 冒烟实证——mcp.json 少了 /mcp，agent 拿不到工具后
    // 自己用 Bash 去 curl、手搓 initialize，折腾满 900s 被 kill，judge 却照常准备打分。工具面缺席的诊断
    // 不是「差一点的诊断」，是另一种任务，它的 trace 与分数都不可比。
    let mcpFailed = null;
    const collector = makeStreamCollector({
      captureTools,
      onInit: (ev) => {
        const failed = (Array.isArray(ev.mcp_servers) ? ev.mcp_servers : []).filter((m) => m?.status !== "connected");
        if (failed.length) {
          mcpFailed = failed;
          try { p.kill("SIGKILL"); } catch { /* */ }
        }
      },
    });
    const killer = timeoutMs > 0
      ? setTimeout(() => { timedOut = true; try { p.kill("SIGKILL"); } catch { /* */ } }, timeoutMs)
      : null;
    const rl = readline.createInterface({ input: p.stdout });
    rl.on("line", (line) => { if (line) collector.onLine(line); });
    p.stderr.on("data", (d) => errChunks.push(d));
    p.on("error", reject);
    p.on("close", (code) => {
      rl.close();
      if (killer) clearTimeout(killer);
      if (ownsCwd) { try { fs.rmSync(sessionCwd, { recursive: true, force: true }); } catch { /* */ } }
      if (mcpFailed) {
        const detail = mcpFailed.map((m) => `${m.name}(${m.status})`).join(", ");
        reject(new Error(`MCP 连接失败：${detail}——已在起跑时终止（工具连不上不许盲跑；查 mcp.json 的 url/headers）`));
        return;
      }
      // 超时 / 非零退出：错误上挂 partial（到 kill 为止收到的 sessionId / toolCalls / usage / 半截 prose）。
      // 2026-09-09 P0 跑批实证：opus 一条体检 900s 被 SIGKILL，Stop/SessionEnd 都没跑到，716 条 span 落地却
      // 0 个 root，runner 又因拿不到 sessionId 连 error event 都不写——一个超时的用例在实验里完全不存在。
      // sessionId 在 system/init 首行就有，被 kill 也拿得到；调用方靠它去收尸（补 root）与照实写 event。
      if (timedOut) {
        const err = new Error(`${bin} 超时（>${timeoutMs}ms），已 kill`);
        err.timedOut = true;
        err.partial = collector.finish();
        reject(err);
        return;
      }
      if (code !== 0) {
        const errText = Buffer.concat(errChunks).toString("utf8");
        const err = new Error(`${bin} exit=${code}: ${errText.slice(0, 400)}`);
        err.exitCode = code;
        err.partial = collector.finish();
        reject(err);
        return;
      }
      resolve(collector.finish());
    });
  });
}

function runCodex({ prompt, model, cwd }) {
  return new Promise((resolve, reject) => {
    const bin = agentBin();
    const workdir = cwd || agentCwd();
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "e2e-codex-"));
    const outFile = path.join(tmp, "last.txt");
    const full = prompt.trim();
    const args = [
      "exec", "--ephemeral",
      "-s", "danger-full-access",
      "--skip-git-repo-check",
      "-C", workdir,
      "-o", outFile,
    ];
    if (model) args.push("-m", model);

    const errChunks = [];
    const p = spawn(bin, args, {
      cwd: workdir,
      env: process.env,
      stdio: ["pipe", "pipe", "pipe"],
    });
    p.stdin.write(full);
    p.stdin.end();
    p.stderr.on("data", (d) => errChunks.push(d));
    p.on("error", reject);
    p.on("close", (code) => {
      try {
        if (code !== 0) {
          const err = Buffer.concat(errChunks).toString("utf8");
          reject(new Error(`${bin} exec exit=${code}: ${(err).slice(0, 400)}`));
          return;
        }
        if (!fs.existsSync(outFile)) {
          reject(new Error(`${bin} exec: no output at ${outFile}`));
          return;
        }
        resolve({ prose: fs.readFileSync(outFile, "utf8"), toolCalls: [] });
      } finally {
        try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* */ }
      }
    });
  });
}

/**
 * @param {{ prompt: string, model?: string, mcpConfigPath?: string, cwd?: string, captureTools?: boolean,
 *           extraArgs?: string[], extraEnv?: Record<string,string>, timeoutMs?: number }} opts
 * @returns {Promise<{ prose: string, toolCalls: object[], sessionId?: string, usage?: object|null, costUsd?: number|null, numTurns?: number|null }>}
 */

/**
 * Cursor Agent CLI stream-json collector.
 * Events use type=tool_call with nested mcpToolCall / getMcpToolsToolCall (not Claude tool_use).
 * Real MCP invocations are normalized to mcp__<server>__<tool> so run-round hollow checks work.
 */
export function makeCursorStreamCollector({ captureTools }) {
  let prose = "";
  let sessionId = "";
  let usage = null;
  let costUsd = null;
  let numTurns = null;
  const textParts = [];
  const pending = new Map(); // call_id → { tool, args, ts, t0 }
  const toolCalls = [];

  function flattenCursorContent(content) {
    if (typeof content === "string") return content;
    if (Array.isArray(content)) {
      return content.map((b) => {
        if (typeof b === "string") return b;
        const outputLocation = b?.text?.outputLocation ?? b?.outputLocation;
        const outputPath = outputLocation?.filePath;
        if (typeof outputPath === "string" && outputPath.length > 0) {
          try {
            return fs.readFileSync(outputPath, "utf8");
          } catch {
            // Cursor can delete the spill file before this event is consumed.
            // Retain the pointer below in that rare case for auditability.
          }
        }
        if (b?.text?.text) return b.text.text;
        if (typeof b?.text === "string") return b.text;
        if (b?.type === "text" && b.text) return b.text;
        return JSON.stringify(b);
      }).join("\n");
    }
    if (content == null) return "";
    return typeof content === "object" ? JSON.stringify(content) : String(content);
  }

  function onLine(line) {
    let ev;
    try { ev = JSON.parse(line); } catch { return; }
    if (!sessionId && typeof ev.session_id === "string") sessionId = ev.session_id;

    if (ev.type === "assistant" && ev.message?.content) {
      for (const blk of ev.message.content) {
        if (blk.type === "text" && blk.text) textParts.push(blk.text);
      }
    }

    if (captureTools && ev.type === "tool_call") {
      const callId = ev.call_id || ev.tool_call?.toolCallId;
      const tc = ev.tool_call || {};
      if (ev.subtype === "started") {
        if (tc.mcpToolCall) {
          const a = tc.mcpToolCall.args || {};
          const server = a.serverIdentifier || a.providerIdentifier || "cursor";
          const toolName = a.toolName || String(a.name || "").replace(new RegExp(`^${server}-`), "");
          const tool = `mcp__${server}__${toolName || a.name || "unknown"}`;
          pending.set(callId, {
            tool,
            args: a.args ?? null,
            ts: new Date().toISOString(),
            t0: Date.now(),
          });
        }
        // getMcpToolsToolCall / other harness meta tools: ignore for mcp__ hollow check
      } else if (ev.subtype === "completed") {
        const u = pending.get(callId);
        if (u && tc.mcpToolCall) {
          pending.delete(callId);
          const result = tc.mcpToolCall.result || {};
          const success = result.success;
          const err = result.error || result.failure;
          let output = "";
          let outcome;
          if (success) {
            output = flattenCursorContent(success.content ?? success);
            if (
              success.isError === true
              || success.is_error === true
              || /^(?:MCP error\b|Input validation error\b|Bad argument:|Failed to\b|[a-z][a-z0-9_.-]* failed:)/i.test(output.trim())
            ) {
              outcome = "error";
            }
          } else if (err) {
            output = flattenCursorContent(err);
            outcome = "error";
          } else {
            output = flattenCursorContent(result);
          }
          toolCalls.push({
            tool: u.tool,
            args: u.args,
            output,
            output_len: output.length,
            duration_ms: Math.max(0, Date.now() - u.t0),
            ts: u.ts,
            outcome,
          });
        }
      }
    }

    if (ev.type === "result") {
      if (typeof ev.result === "string") prose = ev.result;
      if (ev.usage && typeof ev.usage === "object") {
        // Cursor uses inputTokens/outputTokens; keep raw for callers
        usage = ev.usage;
      }
      if (typeof ev.total_cost_usd === "number") costUsd = ev.total_cost_usd;
      if (typeof ev.num_turns === "number") numTurns = ev.num_turns;
    }
  }

  function finish() {
    if (captureTools) {
      for (const u of pending.values()) {
        toolCalls.push({ tool: u.tool, args: u.args, output: "", output_len: 0, duration_ms: 0, ts: u.ts });
      }
    }
    if (!prose) prose = textParts.join("\n").trim();
    const longest = textParts.reduce((a, b) => (b.trim().length > a.trim().length ? b : a), "");
    if (prose.length < 300 && longest.trim().length > prose.length) prose = longest.trim();
    return { prose, toolCalls, sessionId, usage, costUsd, numTurns };
  }

  return { onLine, finish };
}

function runCursor({ prompt, model, cwd, captureTools, extraArgs, extraEnv, timeoutMs }) {
  return new Promise((resolve, reject) => {
    const bin = agentBin();
    // Cursor reads MCP from ~/.cursor/mcp.json (no --mcp-config). Ensure dbdog-local is ready.
    const args = [
      "-p", prompt,
      "--force",
      "--approve-mcps",
      "--trust",
      "--output-format", "stream-json",
    ];
    if (model) args.push("--model", model);
    if (Array.isArray(extraArgs) && extraArgs.length) args.push(...extraArgs);

    // Cursor gets MCP/auth from ~/.cursor, so it does not need the repository
    // cwd. Per-session isolation keeps benchmark expected roots and source files
    // outside a blind diagnosis.
    const sessionCwd = cwd || fs.mkdtempSync(path.join(os.tmpdir(), "e2e-cursor-"));
    const ownsCwd = !cwd;
    const env = { ...process.env, ...(extraEnv || {}) };
    const collector = makeCursorStreamCollector({ captureTools });
    const errChunks = [];
    const p = spawn(bin, args, { cwd: sessionCwd, env, stdio: ["ignore", "pipe", "pipe"] });
    let timedOut = false;
    const killer = timeoutMs > 0
      ? setTimeout(() => { timedOut = true; try { p.kill("SIGKILL"); } catch { /* */ } }, timeoutMs)
      : null;
    const rl = readline.createInterface({ input: p.stdout });
    rl.on("line", (line) => { if (line) collector.onLine(line); });
    p.stderr.on("data", (d) => errChunks.push(d));
    p.on("error", reject);
    p.on("close", (code) => {
      rl.close();
      if (killer) clearTimeout(killer);
      if (ownsCwd) { try { fs.rmSync(sessionCwd, { recursive: true, force: true }); } catch { /* */ } }
      if (timedOut) {
        reject(new Error(`${bin} 超时（>${timeoutMs}ms），已 kill`));
        return;
      }
      if (code !== 0) {
        const err = Buffer.concat(errChunks).toString("utf8");
        reject(new Error(`${bin} exit=${code}: ${err.slice(0, 400)}`));
        return;
      }
      resolve(collector.finish());
    });
  });
}

export function runAgentCli(opts) {
  const kind = resolveAgentKind();
  if (kind === "codex") {
    // codex 经 .codex/config.toml 连 MCP；同样只喂用户原话，不带 system。
    return runCodex({ ...opts, cwd: opts.cwd || agentCwd() });
  }
  if (kind === "cursor") {
    // Cursor Agent CLI：MCP 来自 ~/.cursor/mcp.json；默认一次性 cwd，避免仓库答案泄漏。
    return runCursor(opts);
  }
  return runClaude(opts); // cwd 不传 → runClaude 每 session 建一次性临时 cwd（H1 隔离）
}
