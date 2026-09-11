#!/usr/bin/env node
// chain-rebuild.mjs — 判卷前，用一次模型调用把一条 case 的声明假设树重建成语义因果链（owner 2026-09-11）。
//
// 为什么：账本是平铺的（三条线上 trace `parent_edges=0`），但报告正文里都能读出多环的链；父子断开后
// 判定会互相打架（父桶证伪、桶里的具体机制证实）。判卷方拿着账本判「结论对不对」会被带歪。
// 所以在 judge-package-export 导包之后、起判题会话之前，多产两份材料：chain.json（机器读）+ chain.md（人读）。
//
// 用法：
//   node scripts/llmobs/chain-rebuild.mjs --case <判题包里的 cases/<event_id> 目录>
//        [--model M] [--config-dir ~/.claude] [--timeout-sec 300] [--strict]
//
// 模型：**跟诊断同一个**（owner：「重建链跟诊断用同一个模型就 ok」）。诊断走的是 `~/.claude` 那份配置的
// env 块（ANTHROPIC_BASE_URL + ANTHROPIC_MODEL，见 judge-run/SKILL.md 的模型分工表），所以这里默认
// CLAUDE_CONFIG_DIR=~/.claude 起 headless claude；判题 loop 自己跑在 ~/.claude-max（opus）下，互不影响。
// 显式 --model 最优先。
//
// 会话形态：--print 单轮、不挂 MCP（重建只读材料不取证）、禁 hooks 与 slash 命令（不让操作者的本地面泄进来）、
// 一次性 cwd。纯函数层与形状校验在 lib/chain-rebuild.mjs，单测在 lib/chain-rebuild.test.mjs。
//
// 退出码：默认**永远 0**——这一步不能成为判卷的阻塞点，失败只在 stderr 报一行、包里少两份文件；
// --strict 时 failed 退 2（给本地调 prompt 用）。skipped（trace 没有假设编号）任何情况下都是 0。
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { runAgentCli } from "../e2e/lib/agent-cli.mjs";
import { resolveAgentIdentity } from "./lib/agent-identity.mjs";
import { rebuildChain } from "./lib/chain-rebuild.mjs";

const argOf = (name, dflt) => {
  const i = process.argv.indexOf(name);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : dflt;
};
const has = (name) => process.argv.includes(name);

const CASE_DIR = argOf("--case", "");
const MODEL = argOf("--model", "");
const CONFIG_DIR = path.resolve(argOf("--config-dir", path.join(os.homedir(), ".claude")).replace(/^~(?=$|\/)/, os.homedir()));
const TIMEOUT_MS = Number(argOf("--timeout-sec", "300")) * 1000;
const STRICT = has("--strict");

if (!CASE_DIR) {
  console.error("✗ --case 必填（判题包里的 cases/<event_id> 目录）");
  process.exit(1);
}

/** 记进 chain.json 的模型名：显式 --model > 配置目录 settings.json 的 env.ANTHROPIC_MODEL > unknown（只读不猜）。 */
function modelIdentity() {
  let env = {};
  try {
    env = JSON.parse(fs.readFileSync(path.join(CONFIG_DIR, "settings.json"), "utf8")).env ?? {};
  } catch {
    /* 配置目录没有 settings.json 就只看进程环境 */
  }
  return resolveAgentIdentity({ model: MODEL, env: { ...process.env, ...env } });
}

async function runAgent({ prompt }) {
  // 不挂 MCP：写一份空的 mcpServers 并 --strict-mcp-config，免得 CLI 去装配置目录里的 MCP（慢，且用不上）。
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "chain-rebuild-"));
  const mcpConfigPath = path.join(tmp, "mcp.json");
  fs.writeFileSync(mcpConfigPath, JSON.stringify({ mcpServers: {} }));
  return runAgentCli({
    prompt,
    ...(MODEL ? { model: MODEL } : {}),
    mcpConfigPath,
    cwd: tmp,
    captureTools: false,
    extraArgs: ["--settings", JSON.stringify({ disableAllHooks: true }), "--disable-slash-commands"],
    extraEnv: { CLAUDE_CONFIG_DIR: CONFIG_DIR },
    timeoutMs: TIMEOUT_MS,
  });
}

const identity = modelIdentity();
console.error(`↻ 重建链：${CASE_DIR}（模型 ${identity.model}，来源 ${identity.source}，配置目录 ${CONFIG_DIR}）`);
const r = await rebuildChain({ caseDir: CASE_DIR, runAgent, model: identity.model });
if (r.status === "ok") {
  console.error(`✓ 重建链：声明深度 ${r.depth_declared} → 重建深度 ${r.depth_semantic}，判定冲突 ${r.conflicts} 处（chain.json / chain.md 已写）`);
} else if (r.status === "skipped") {
  console.error(`— 重建链跳过：${r.reason}`);
} else {
  console.error(`✗ 重建链失败（包里不产 chain.*，判卷照常）：${r.reason}`);
  if (STRICT) process.exit(2);
}
