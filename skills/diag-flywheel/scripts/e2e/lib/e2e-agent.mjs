// e2e-agent.mjs — 诊断 agent 后端：session（IDE 会话）| cli（Claude / Codex / Cursor headless）。
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { intentPrefix } from "./demand.mjs";
import { telemetryDir } from "./round-fs.mjs";
import { runAgentCli } from "./agent-cli.mjs";
import { agentCwd, resolveAgentKind } from "./agent-kind.mjs";
import { resolveRunSuffix } from "./round-meta.mjs";
import { ddMcpHeaders } from "../../lib/dd-mcp-auth.mjs";

function runSuffix() {
  return resolveRunSuffix();
}

export const AGENT_BACKENDS = ["auto", "session", "cli"];

/** session = 生成 prepare 清单，由操作者所在 agent/IDE 会话执行（默认）。cli = headless（Claude / Codex）。 */
export function resolveAgentBackend(argv = process.argv) {
  const i = argv.indexOf("--agent");
  let v = i >= 0 && argv[i + 1] ? argv[i + 1] : null;
  if (!v && process.env.E2E_AGENT_BACKEND) v = process.env.E2E_AGENT_BACKEND;
  if (v === "cursor") v = "session";
  if (v) return v;
  if (process.env.E2E_AGENT_BIN || process.env.E2E_AGENT_KIND) return "cli";
  return "session";
}

// buildSysPrompt / buildDdSysPrompt 已移除（2026-07-01）：批量跑不再向 agent 注入任何 harness
// 话术。真实用户不会自带 sysprompt——只投喂用户原话（runClaude 的 --print），一切引导本就在
// MCP 的 SERVER_INSTRUCTIONS 出口。以前给 dbdog/DD 塞不同话术（select-先 vs 关键词-先、"官方"
// vs "助手"）反而污染了对照，现两栈唯一变量只剩「连哪个 MCP」。输出格式由报告拼装侧宽容解析
// （prose.splitProse 无小节时整段入 head），telemetry.intent 由 attachCaseIntent 事后打前缀。

export function buildDdMcpConfig() {
  const domain = process.env.DD_MCP_DOMAIN || "mcp.us5.datadoghq.com";
  const toolsets = process.env.DD_MCP_TOOLSETS_E2E || "core,dbm,ddsql";
  return {
    mcpServers: {
      datadog: {
        type: "http",
        url: `https://${domain}/v1/mcp?toolsets=${toolsets}`,
        headers: ddMcpHeaders({ requireCredentials: false }),
      },
    },
  };
}

// DBDOG_MCP_URL 只给到主机端口（如 diff-hunt loop 的 secrets.env 那种用法）时补上 MCP 入口 /mcp——
// 2026-09-09 实证：裸 origin 让 claude 的 http MCP 客户端 status=failed，agent 无工具盲跑到超时。
export function normalizeMcpUrl(raw) {
  const v = (raw || "").trim();
  if (!v) return "";
  let u;
  try { u = new URL(v); } catch { return v; }
  if (u.pathname === "" || u.pathname === "/") {
    u.pathname = "/mcp";
    console.error(`⚠ DBDOG_MCP_URL 无路径，按 MCP 入口补成 ${u.origin}/mcp`);
  }
  return u.toString();
}

// dbdog-mcp 现为托管 HTTP 服务（Streamable HTTP，box 上跑，连 localhost 的 dbdog-server），
// 与 Datadog 托管 MCP 同形态 —— harness 对两栈都走 HTTP、遥测都从 stream-json 抽（对称）。
// URL 经 DBDOG_MCP_URL 覆盖，默认公网隧道 :24267 → box:8090 dbdog-mcp。
export function buildMcpConfig() {
  const url = normalizeMcpUrl(process.env.DBDOG_MCP_URL)
    || "http://epyc-256c.e6.luyouxia.net:24267/mcp?toolsets=core,dbm,ddsql,llmobs,profiling,data-observability";
  // 北向 OAuth 门禁后，headless spawn 读不到交互式客户端的 OAuth 会话（实测 needs-auth）；
  // 跑批经 DBDOG_MCP_BEARER 显式注入（与 DD 栈 headers 传 key 同形）。
  const bearer = (process.env.DBDOG_MCP_BEARER || "").trim();
  return {
    mcpServers: {
      "dbdog": bearer
        ? { type: "http", url, headers: { Authorization: `Bearer ${bearer}` } }
        : { type: "http", url },
    },
  };
}

export function prepareDir(e2e, round) {
  return path.join(telemetryDir(e2e, round), "prepare");
}

export function answersDir(e2e, round) {
  return path.join(telemetryDir(e2e, round), "answers");
}

function casePromptDoc({ round, c, priorGuidance }) {
  const suffix = runSuffix();
  const pfx = intentPrefix(round, c.num, suffix);
  const RR = String(round).padStart(2, "0");
  return `# Case ${c.num} · ${c.slug} · 盲诊断

## 遥测（必做）
- 每次 dbdog 工具 \`telemetry.intent\` 以 \`${pfx} \` 开头
- 遥测落盘：\`rounds/.telemetry/round-${RR}/demand.jsonl\`（MCP 环境 \`DBDOG_TELEMETRY_LOG\`）

## 用户原话
${c.nl}

## 完成后（诊断阶段结束）
1. 将四节 RCA 写入 \`rounds/.telemetry/round-${RR}/answers/${c.num}.md\`
2. 执行：
\`\`\`sh
node scripts/e2e/ingest-diagnosis.mjs --round ${round} --case ${c.num}
\`\`\`
3. **不要**在本阶段打开 \`CUJBench-expected-roots.md\`
`;
}

/** 为任意 agent/IDE 会话生成跑批清单（不 spawn 外部进程）。 */
export function writeSessionPrepareBundle({ e2e, round, cases, priorGuidance = "" }) {
  const RR = String(round).padStart(2, "0");
  const root = prepareDir(e2e, round);
  const ans = answersDir(e2e, round);
  fs.mkdirSync(root, { recursive: true });
  fs.mkdirSync(ans, { recursive: true });

  const demandFile = path.join(telemetryDir(e2e, round), "demand.jsonl");
  const manifest = {
    round,
    backend: "session",
    demandFile,
    answersDir: ans,
    cases: cases.map((c) => ({
      num: c.num,
      slug: c.slug,
      scenario_id: c.scenario_id,
      intentPrefix: intentPrefix(round, c.num, runSuffix()),
      promptFile: `prepare/${c.num}/prompt.md`,
      answerFile: `answers/${c.num}.md`,
    })),
  };

  for (const c of cases) {
    const dir = path.join(root, c.num);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "prompt.md"), casePromptDoc({ round, c, priorGuidance }));
    fs.writeFileSync(
      path.join(dir, "mcp.json"),
      `${JSON.stringify(buildMcpConfig(), null, 2)}\n`,
    );
  }

  const runMd = [
    `# E2E round-${RR} · 会话跑批`,
    "",
    "在**你正在使用的 agent/IDE 会话**中按序执行下列用例。",
    "",
    `- 盲诊断阶段：**禁止**读 \`CUJBench-expected-roots.md\``,
    "",
    `遥测：\`${demandFile}\``,
    "",
    "## 用例列表",
    ...cases.map((c) => `- **${c.num}** ${c.slug} → [\`prepare/${c.num}/prompt.md\`](prepare/${c.num}/prompt.md)`),
    "",
    "## 每例流程（三步）",
    "1. 读 `prepare/NNN/prompt.md` → 盲诊断（intent `R" + RR + "SNNN:`）",
    "2. 写 `answers/NNN.md`",
    "3. `node scripts/e2e/ingest-diagnosis.mjs --round " + round + " --case NNN`",
    "",
    "全部完成后：`node scripts/e2e/finish-round.mjs --round " + round + "`，生成 `interface-analysis.html`、`round-NN/index.html`、`rounds/index.html`",
    "",
    "## CLI 替代（Claude / Codex）",
    "设 `E2E_AGENT_BIN`（可选 `E2E_AGENT_KIND=claude|codex|cursor`；Codex 需 `E2E_AGENT_CWD` 指向含 `.codex/config.toml` 的项目根；Cursor 需本机 `dbdog-local` MCP ready）后：",
    "- `node scripts/e2e/run-round-local.mjs --round " + round + " --agent cli`",
    "",
  ].join("\n");

  fs.writeFileSync(path.join(root, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
  fs.writeFileSync(path.join(root, "RUN.md"), runMd);
  return { root, runMdPath: path.join(root, "RUN.md"), manifest };
}

export const writeCursorPrepareBundle = writeSessionPrepareBundle;

/** 外部 CLI headless（Claude / Codex / Cursor；需本机鉴权）。captureTools=从 stream-json 抽工具调用。 */
export async function runDiagnoseViaCli({ nl, mcpConfigPath, model, captureTools = false }) {
  const kind = resolveAgentKind();
  try {
    const { prose, toolCalls } = await runAgentCli({
      prompt: nl,
      model,
      // Claude：每案注入 mcp.json。Cursor：读 ~/.cursor/mcp.json（需 dbdog-local ready）。
      mcpConfigPath: kind === "claude" ? mcpConfigPath : undefined,
      // claude/cursor 不传 cwd → 一次性临时 cwd；codex 仍需项目 .codex/config.toml
      cwd: kind === "codex" ? agentCwd() : undefined,
      captureTools,
    });
    return { code: 0, prose, toolCalls: toolCalls || [], stderr: "" };
  } catch (e) {
    return { code: 1, prose: "", toolCalls: [], stderr: String(e.message || e) };
  }
}

export function mkCaseTmp({ round, backend = "dbdog" }) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), `e2e-r${String(round).padStart(2, "0")}-`));
  const cfg = path.join(tmp, "mcp.json");
  const mcpConfig = backend === "datadog" ? buildDdMcpConfig() : buildMcpConfig();
  fs.writeFileSync(cfg, JSON.stringify(mcpConfig, null, 2));
  return { tmp, cfg };
}
