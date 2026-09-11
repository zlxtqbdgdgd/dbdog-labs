#!/usr/bin/env node
// run-experiment.mjs — llmobs experiment runner（eval 面 E2，e2e 旁路的正路替代）。
//
// 做什么：把 dataset（E1 导入的 DiagBench 27 用例）逐条跑成一次 experiment——
// 每条 record → 一个 headless Claude 会话（复用 e2e spawn 内核 + claude-code-hooks 采集）
// → 一条 llmobs trace + 一行 experiment_event（trace_id/dataset_record_id 关联，
// LLM-judge 分 + 确定性指标写 metrics）。不再使用 intent 前缀/demand.jsonl 旧协议。
//
// 在哪跑：开发机（Mac，需本机 claude CLI 登录态）。所需 env：
//   DBDOG_BASE_URL        dbdog-server REST（隧道 → box:8080）
//   DBDOG_API_KEY         控制台 /settings/api-keys 签发的 key（读 dataset / 写 events+spans）。**推荐**：
//                         普通用户拿得到的就这一把，与 hooks 上报 span 同一把；key 自带租户。
//   DBDOG_INTERNAL_TOKEN  内部服务凭证。没有 API key 时的回落（内部/CI 面），租户靠 DBDOG_ORG 头指定
//   DBDOG_MCP_URL         dbdog-mcp（默认公网隧道 :24267/mcp）
//   DBDOG_MCP_BEARER      agent 连 MCP 的短时 JWT（scripts/llmobs/mint-mcp-jwt.mjs 铸）
//   E2E_PROMPT_USER/PASS 注入平台（--prompt-source platform 时需要）
//   DBDOG_HOOKS_DIR       可选；hooks 母版目录，默认同级检出 ../dbdog-labs（脚本本体在其
//                         claude-code-hooks/，接线照 hooks/hooks.json 镜像——缺一样就 fail closed）
//
// 用法：
//   node scripts/llmobs/run-experiment.mjs --experiment diagbench-0712-a [--parent <name|uuid>] \
//     [--scenarios 000,001,204] [--limit N] [--prompt-source auto|platform|dataset] \
//     [--model MODEL] [--judge-model MODEL] [--concurrency 2] [--timeout-sec 900] [--dry-run]
//
// --workdir <路径>：固定工作目录 = 被诊断系统的源码树（给了就不铺模板、不删目录）。
//
// **题面里禁止加料**（owner 2026-09-10 定）：题面是用户会怎么问，我们不知道真实用户怎么用，
// 往里塞我们的引导语，测出来的就不是产品面的真实行为了。假设书写约定的唯一定义处是
// `src/toolsets/shared/schema.ts` 里 telemetry.intent 的描述，skill 正文只讲用法并引用同一行示例；
// agent 从工具描述里学，不靠题面兜底。曾经有过一个 --prompt-prefix-file 开关，已按这条删除。
// **例外只有复现时间窗**：它是用例自己的数据，不是引导语——真实用户本来就会说「几点到几点有问题」，
// 不说反而不像真实提问。来源是 `record.metadata.repro`（复现那一步写入），没有就原样发题、
// 绝不编一个窗口出来。见 lib/case-window.mjs。
//
// run 先建后跑（P3/D7）：开跑前先 POST 控制面建一条 run 拿 uuid，events 的 experiment_id 用它，
// 于是判题包的 judge_summary 当场有落点、重测能挂 --parent（对比页按 parent 找基线）。
// --parent 收 uuid / run 名 / 逻辑名（同逻辑名多条取最新一条），解析不到直接停。
//
// 提示词来源：platform = 注入平台当轮 NL（新时间窗，真实验推荐）；dataset = record 里存的
// dataset 中保存的来源轮样例 NL（窗口陈旧，仅链路演练用）；auto = 配了 E2E_PROMPT_USER 用 platform，否则
// dataset 并告警。
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { runAgentCli } from "../e2e/lib/agent-cli.mjs";
import { buildMcpConfig } from "../e2e/lib/e2e-agent.mjs";
import { runWorkerPool } from "../e2e/lib/worker-pool.mjs";
import {
  loadDataset, postExperimentEvent, postSpans, dedupSpans, getExperimentSummary, baseUrl,
  createExperimentRun, resolveExperimentRef, patchCPExperiment,
  requireCredential,
} from "./lib/exp-client.mjs";
import { judgeOne, judgeMetrics } from "./lib/judge.mjs";
import { promptWithWindow } from "./lib/case-window.mjs";
import { orchestrationMetrics } from "./lib/orchestration-metrics.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
// hooks 母版 2026-07-14 迁到公开仓 dbdog-labs（本仓 clients/claude-code-hooks 只剩指路 README）。
// 缺了不许静默跑——那样 judge 照打分、trace 却是空的。
//
// 母版在哪，取决于**这份脚本自己是母版还是镜像**（`sync-flywheel-kit.mjs` 会把它镜像进 labs 插件）：
//   母版：mcp 仓 `scripts/llmobs/` → 家族平级检出，`../dbdog-labs`
//   镜像：labs 插件 `skills/diag-flywheel/scripts/llmobs/` → hooks 就在插件自己里，往上两层
// 不靠新加一个 env 区分——用户装完插件不该还要配环境变量才能跑；靠特征文件探，
// 探不到就退回母版候选，让下游 fail closed 去报「hooks 母版缺失」（错误信息在那儿更准）。
function resolveLabsRoot() {
  const candidates = [path.resolve(ROOT, "..", "dbdog-labs"), path.resolve(ROOT, "..", "..")];
  return candidates.find((c) => fs.existsSync(path.join(c, "claude-code-hooks", "lib.mjs"))) ?? candidates[0];
}
const LABS_ROOT = process.env.DBDOG_HOOKS_DIR?.trim() || resolveLabsRoot();

const argOf = (name, dflt) => {
  const i = process.argv.indexOf(name);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : dflt;
};
const has = (name) => process.argv.includes(name);
function fail(msg) {
  console.error(`✗ ${msg}`);
  process.exit(1);
}

// ---- 参数 ----
const pad = (n) => String(n).padStart(2, "0");
const now = new Date();
const defaultExpID = `diagbench-${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}`;
const EXPERIMENT = argOf("--experiment", defaultExpID);
// 重测挂基线：给了就必须解析得到（D7 对比页按它找 parent）。
const PARENT = argOf("--parent", "");
const PROJECT = argOf("--project", "default-project");
const DATASET = argOf("--dataset", "diagbench");
const SCENARIOS = argOf("--scenarios", "").split(",").map((s) => s.trim()).filter(Boolean);
const LIMIT = Number(argOf("--limit", "0"));
const PROMPT_SOURCE = argOf("--prompt-source", "auto");
const MODEL = argOf("--model", "");
const JUDGE_MODEL = argOf("--judge-model", "");
// 并发默认 1：本机多个 claude 进程并发会抢登录态（2026-07-12 实测 exit=1 空 stderr），
// 且 judge 也是 claude 进程。要提并发先在你机器上验证 --concurrency 2 稳定。
const CONCURRENCY = Number(argOf("--concurrency", "1"));
const TIMEOUT_MS = Number(argOf("--timeout-sec", "900")) * 1000;
const ML_APP = argOf("--ml-app", "diagbench-runner");
const NOTES = argOf("--notes", "");
// 每用例工作目录模板：默认放入诊断目录模板 CLAUDE.md（host 层行为引导——与场景 A 真实
// 用户目录同一份，跑批测的就是产品面；SERVER_INSTRUCTIONS/skill 是 DD 逐字镜像不可加料）。
// --workdir-template none 恢复空目录（量「裸」行为用）。
const WORKDIR_TEMPLATE = argOf("--workdir-template", path.join(ROOT, "clients", "diag-workdir-template"));
// --workdir：固定工作目录（评测场景 = 被诊断系统的内核源码树，让 `code` skill 能面对源码、
// 把根因钉到 file:line）。给了它就**不铺模板**——往源码树里铺 CLAUDE.md 会弄脏被测树，
// 作弊体检那关会报 HEAD 不干净。
const WORKDIR = argOf("--workdir", "");
if (WORKDIR && !fs.existsSync(WORKDIR)) fail(`--workdir 不存在：${WORKDIR}`);
const DRY = has("--dry-run");

requireCredential();

// ---- hooks 接线（spawn 的 cwd 是临时目录，项目级 settings 不可达 → --settings 内联注入）----
// 单源 = dbdog-labs/hooks/hooks.json（插件用户装的就是这份）：把 ${CLAUDE_PLUGIN_ROOT} 换成检出根，
// 六个事件（含 SessionStart 收尸 / SessionEnd 补尾——手列四个会丢尾部 llm span）原样继承。
function loadHooksSettings() {
  const hooksJson = path.join(LABS_ROOT, "hooks", "hooks.json");
  if (!fs.existsSync(hooksJson)) {
    fail(`hooks 母版缺失：${hooksJson}（clone zlxtqbdgdgd/dbdog-labs 到同级目录，或设 DBDOG_HOOKS_DIR）`);
  }
  const raw = fs.readFileSync(hooksJson, "utf8").replaceAll("${CLAUDE_PLUGIN_ROOT}", LABS_ROOT);
  const parsed = JSON.parse(raw);
  for (const entries of Object.values(parsed.hooks ?? {})) {
    for (const entry of entries) {
      for (const h of entry.hooks ?? []) {
        const m = /^node "([^"]+)"/.exec(h.command ?? "");
        if (!m || !fs.existsSync(m[1])) fail(`hooks 脚本缺失：${h.command}`);
      }
    }
  }
  return JSON.stringify({ hooks: parsed.hooks });
}
const hooksSettings = loadHooksSettings();

/**
 * 收尸：agent 被 kill（超时 / 非零退出）后 Stop 与 SessionEnd 都不会触发，root span 永远不发、
 * in-flight 子代理整棵消失（2026-09-09 P0 实证：716 条 span、0 个 root）。hooks 自己的 session-end.mjs
 * 就是干这个的（补 root + 主线尾部 + 子代理树，全部幂等），只是没人去触发它——runner 在这里替 Claude Code
 * 触发一次：stdin 喂 {session_id}，状态文件里有 transcript_path，其余它自己找。
 * 失败只警告不阻塞：收不了尸的 trace 照实是残的，event 仍要写。
 */
function reapSession(sessionId, obsDir, reason) {
  const script = path.join(LABS_ROOT, "claude-code-hooks", "session-end.mjs");
  return new Promise((resolve) => {
    const p = spawn(process.execPath, [script], {
      env: { ...process.env, DBDOG_OBS_MODE: "always", DBDOG_OBS_DIR: obsDir, DBDOG_OBS_ML_APP: ML_APP },
      stdio: ["pipe", "ignore", "pipe"],
    });
    const err = [];
    p.stderr.on("data", (d) => err.push(d));
    const timer = setTimeout(() => { try { p.kill("SIGKILL"); } catch { /* */ } }, 60_000);
    p.on("error", (e) => { clearTimeout(timer); resolve(`收尸脚本起不来：${e.message}`); });
    p.on("close", (code) => {
      clearTimeout(timer);
      resolve(code === 0 ? "" : `收尸脚本 exit=${code}: ${Buffer.concat(err).toString("utf8").slice(0, 300)}`);
    });
    p.stdin.end(JSON.stringify({ session_id: sessionId, hook_event_name: "SessionEnd", reason }));
  });
}

/**
 * 这条 trace 的 span（hooks 落盘的 spans.jsonl 里按 trace_id 挑）。读的时点与读 `${sessionId}.json`
 * 状态文件同一处——两者都是 hooks 收尾时的产物，那边读得到这边就读得到。
 * 半行（并发跑批时另一条 case 正在追加）跳过，不让一行坏 JSON 把整轮指标废掉。
 * 一条都挑不出来回 null：**缺数据不许发一串 0**（0 和「没读到」不是一回事）。
 */
function traceSpansOf(obsDir, traceId) {
  const file = path.join(obsDir, "spans.jsonl");
  if (!traceId || !fs.existsSync(file)) return null;
  const out = [];
  for (const line of fs.readFileSync(file, "utf8").split("\n")) {
    if (!line.trim()) continue;
    try {
      const sp = JSON.parse(line);
      if (sp?.trace_id === traceId) out.push(sp);
    } catch { /* 半行 / 坏行：跳过 */ }
  }
  return out.length ? dedupSpans(out) : null;
}

async function resolvePrompts(records) {
  const wantPlatform = PROMPT_SOURCE === "platform" || (PROMPT_SOURCE === "auto" && process.env.E2E_PROMPT_USER);
  if (wantPlatform) {
    const { fetchE2eNl } = await import("../e2e/lib/prompt-fetch.mjs");
    const { nl, injectionRunning } = await fetchE2eNl({ wait: false });
    if (injectionRunning) console.error("⚠ 注入平台仍在跑批，NL 可能不含全部场景");
    return { source: "platform", promptOf: (r) => nl[r.metadata?.scenario_id] };
  }
  if (PROMPT_SOURCE === "auto" && DATASET === "diagbench") {
    console.error("⚠ 未配 E2E_PROMPT_USER，diagbench 用存量样例 NL（时间窗陈旧，判分仅供链路演练）");
  }
  return { source: "dataset", promptOf: (r) => r.input?.prompt };
}

// ---- 单条执行 ----
async function runOne(record, idx, ctx) {
  const meta = record.metadata ?? {};
  const kindTag = (record.tags ?? []).find((t) => t.startsWith("kind:"));
  const label = (meta.num || meta.slug)
    ? `${meta.num ?? idx} ${meta.slug ?? ""}`.trim()
    : (kindTag ? kindTag.slice(5) : `#${idx}`);
  // 题面原样发出去，不加料（见文件头「题面里禁止加料」）。唯一拼进去的是**复现时间窗**——
  // 那是这条用例自己的数据、真实用户本来就会说的，不是我们的引导语（lib/case-window.mjs）。
  const bare = ctx.promptOf(record);
  if (!bare) {
    return { record, label, error: `无提示词（scenario ${meta.scenario_id ?? "?"} 不在 ${ctx.source} 源里）` };
  }
  const prompt = promptWithWindow(bare, meta?.repro);

  console.error(`▶ [${label}] 开跑（${ctx.source} NL，${prompt.length} 字符）`);
  const t0 = Date.now();
  // 每用例独立 cwd（保持 e2e 的 H1 隔离），按模板铺 CLAUDE.md 等 host 层引导。
  // --workdir 给了就用它、不铺模板也不删：那是被诊断系统的源码树，铺文件会弄脏它。
  const fixedCwd = Boolean(WORKDIR);
  const caseCwd = fixedCwd ? WORKDIR : fs.mkdtempSync(path.join(os.tmpdir(), "llmobs-case-"));
  if (!fixedCwd && WORKDIR_TEMPLATE !== "none" && fs.existsSync(WORKDIR_TEMPLATE)) {
    for (const f of fs.readdirSync(WORKDIR_TEMPLATE)) {
      fs.copyFileSync(path.join(WORKDIR_TEMPLATE, f), path.join(caseCwd, f));
    }
  }
  const dropCwd = () => {
    if (fixedCwd) return;                       // 固定目录是别人的，删了就闯祸
    dropCwd();
  };
  let run;
  try {
    run = await runAgentCli({
      prompt,
      model: MODEL || undefined,
      mcpConfigPath: ctx.mcpConfigPath,
      cwd: caseCwd,
      captureTools: true,
      extraArgs: ["--settings", hooksSettings, "--disable-slash-commands"],
      extraEnv: {
        DBDOG_OBS_MODE: "always",
        DBDOG_OBS_DIR: ctx.obsDir,
        DBDOG_OBS_ML_APP: ML_APP,
      },
      timeoutMs: TIMEOUT_MS,
    });
  } catch (e) {
    dropCwd();
    const failure = `agent 失败：${e.message || e}`;
    const partial = e?.partial;
    if (!partial?.sessionId) {
      // 连 session 都没起来（MCP 连不上 / 二进制起不来）：没有 trace 可收、没有 event 可写。
      return { record, label, error: failure, durationMs: Date.now() - t0 };
    }
    // 跑起来了但没跑完：收尸补 root，然后照实写 status=error 的 event——run 里有哪些 event 就是哪些用例（D7），
    // 超时的漏掉等于把最贵的失败藏起来。
    const reapErr = await reapSession(partial.sessionId, ctx.obsDir, e.timedOut ? "timeout" : "exit");
    console.error(`☠ [${label}] ${failure}；已收尸${reapErr ? `（${reapErr}）` : ""}`);
    run = { ...partial, prose: "", partialProse: partial.prose || "", failure };
  }
  dropCwd();
  const durationMs = Date.now() - t0;

  // trace_id：stream-json 的 session_id → hooks 状态文件。
  let traceId = "", rootSpanId = "";
  if (run.sessionId) {
    try {
      const state = JSON.parse(fs.readFileSync(path.join(ctx.obsDir, `${run.sessionId}.json`), "utf8"));
      traceId = state.trace_id ?? "";
      rootSpanId = state.root_span_id ?? "";
    } catch { /* hooks 未生效 → 无 trace（照实上报空 trace_id） */ }
  }
  // 没 trace 的诊断不许当成功：event 照实上报（trace_id 空），但计入失败、整轮退出码非零——
  // 飞轮的判题包、对比页全建在 trace 上，空 trace 的分数是假的。
  const noTrace = !traceId;
  if (noTrace) console.error(`✗ [${label}] 未捞到 trace_id（hooks 未生效？session=${run.sessionId || "?"}）`);

  // 确定性指标。工具那三个（tool_calls / tool_errors / degraded_calls）由 orchestrationMetrics
  // 从 **span 树** 出，含子代理；这里的 stream-json 只用来出 tool_calls_main_session。
  const tools = run.toolCalls ?? [];
  const usage = run.usage ?? {};
  const score = (label2, value) =>
    Number.isFinite(value) ? [{ label: label2, metric_type: "score", score_value: value, metric_source: "deterministic" }] : [];

  // 编排质量（零模型，从这条 trace 的 span 树算；判据单源 lib/orchestration-metrics.mjs）。
  // 以前只有 LLM 判题事后能看出「fan-out 多少、撞没撞并发上限、假设收没收口、结论引用的假设
  // 树上有没有」，一次判题很贵；这些事实本来就写在 span 上，每轮自动出数才有分布可谈。
  // **本轮只观测不管控**：不设阈值、不加 cap。
  const traceSpans = traceSpansOf(ctx.obsDir, traceId);
  const orch = traceSpans ? orchestrationMetrics(traceSpans) : null;
  // tool_calls / tool_errors / degraded_calls 三条都由它出（span 树，含子代理）。
  // 原来这里把 tool_calls 过滤掉、留 stream-json 那份——那份只有主会话，委派越重低报越多
  // （2026-09-10 实测 411 vs 1128，15 个子代理）。owner 定：子代理也要数。
  const orchMetrics = orch ? Object.entries(orch).flatMap(([label2, value]) => score(label2, value)) : [];

  // LLM-judge（用户侧模型；失败不阻塞事件写入，记 error_message）。没跑完的用例没有结论可判，不浪费一次判题。
  let judged;
  if (run.failure) {
    judged = { error: run.failure };
  } else {
    console.error(`⚖ [${label}] judge…`);
    judged = await judgeOne({
      expected: record.expected_output,
      meta,
      prose: run.prose || "（无结论文本）",
      scenario: `${meta.scenario_id ?? ""} ${meta.slug ?? ""}`.trim(),
      model: JUDGE_MODEL || undefined,
    });
  }

  const metrics = [
    ...judgeMetrics(judged),
    ...score("tokens_input", usage.input_tokens),
    ...score("tokens_output", usage.output_tokens),
    ...score("tokens_cache_read", usage.cache_read_input_tokens),
    // 主会话那份单独留一条：两个数并排才看得出这一轮把多少活派给了子代理。
    // 读不到 span 时（hooks 没生效）上面三条整个不发——缺数据不许发一串 0。
    ...score("tool_calls_main_session", tools.length),
    ...score("num_turns", run.numTurns ?? NaN),
    ...score("cost_usd", run.costUsd ?? NaN),
    ...orchMetrics,
  ];

  const event = {
    event_id: `case-${meta.num ?? record.id}`,
    trace_id: traceId,
    span_id: rootSpanId,
    dataset_record_id: record.id,
    ts: new Date(t0).toISOString(),
    status: run.prose && !run.failure ? "ok" : "error",
    duration_ms: durationMs,
    input: { prompt, prompt_source: ctx.source },
    output: run.failure
      ? { text: run.failure, partial_text: (run.partialProse || "").slice(0, 8_000) }
      : { text: (run.prose || "").slice(0, 32_000) },
    expected_output: record.expected_output ?? null,
    dimensions: {
      scenario: String(meta.slug ?? (kindTag ? kindTag.slice(5) : "")),
      num: String(meta.num ?? ""),
      // dataset/notes 供实验列表自述「拿哪个用例集、为什么跑」（server 列表聚合读它们）。
      dataset: DATASET,
      ...(NOTES ? { notes: NOTES } : {}),
      agent: "claude-cli",
      model: MODEL || "default",
      prompt_source: ctx.source,
      workdir_guidance: WORKDIR_TEMPLATE === "none" ? "off" : "on",
      ...(judged.verdict ? { verdict: judged.verdict } : {}),
    },
    metrics,
  };

  try {
    await postExperimentEvent(ctx.runID, event);
  } catch (e) {
    return { record, label, error: `event 写入失败：${e.message || e}`, judged, durationMs };
  }
  const orchLine = orch
    ? ` · 子代理 ${orch.subagent_count}（峰值 ${orch.subagent_peak_concurrent}，深 ${orch.subagent_depth_max}${orch.subagent_limit_hits ? `，撞上限 ${orch.subagent_limit_hits} 次` : ""}）· 假设 ${orch.hypothesis_count}/收口 ${orch.hypothesis_resolved}${orch.hypothesis_dangling_refs ? `/悬空引用 ${orch.hypothesis_dangling_refs}` : ""}`
    : "";
  console.error(`${noTrace || run.failure ? "✗" : "✓"} [${label}] ${judged.verdict ?? "judge-err"} · ${Math.round(durationMs / 1000)}s · ${orch ? `${orch.tool_calls} tools（主会话 ${tools.length}）` : `${tools.length} tools`} · trace ${traceId.slice(0, 8) || "—"}${orchLine}`);
  return { record, label, judged, traceId, durationMs, noTrace, ...(run.failure ? { error: run.failure } : {}) };
}

// ---- 主流程 ----
const { project, dataset, records: all } = await loadDataset({ projectName: PROJECT, datasetName: DATASET });
let records = all;
if (SCENARIOS.length) {
  records = all.filter((r) => {
    const m = r.metadata ?? {};
    const kind = (r.tags ?? []).find((t) => t.startsWith("kind:"))?.slice(5);
    // record id 也算一种选法，且是最精确的那种：loop-diagnose 拿 loop-pending 吐的就是它。
    return SCENARIOS.includes(String(r.id))
      || SCENARIOS.includes(String(m.num)) || SCENARIOS.includes(String(m.slug))
      || SCENARIOS.includes(String(m.scenario_id)) || (kind && SCENARIOS.includes(kind));
  });
}
if (LIMIT > 0) records = records.slice(0, LIMIT);
if (!records.length) fail("过滤后没有可跑的 record");

// --parent 在开跑前解析、解析不到就停（fail closed，dry-run 也解析）：拼错的 parent 比没有
// parent 更糟——对比页会拿这一轮去跟一条不相干的 run 比，而 parent_experiment_id 列上没有外键，
// server 不会替我们挡下瞎写的 uuid。
let parent = null;
if (PARENT) {
  parent = await resolveExperimentRef(PARENT, { projectID: project.id });
  if (!parent?.id) fail(`--parent 解析不到：${PARENT}（控制面里没有这个 uuid / run 名 / 逻辑名）`);
  console.error(`parent=${parent.id} name=${parent.name ?? "?"}`);
}

const ctx = await resolvePrompts(records);
console.error(`experiment=${EXPERIMENT} dataset=${dataset.name}(${all.length} 条,选 ${records.length}) prompts=${ctx.source} server=${baseUrl()}`);
if (DRY) {
  for (const r of records) console.error(`  - ${r.metadata?.num} ${r.metadata?.slug} prompt=${ctx.promptOf(r) ? "有" : "无"}`);
  process.exit(0);
}

// run 先建后跑：控制面先有行，events 才有 uuid 可挂（events_key = id::text）。
// metadata 记「这一轮是谁、拿哪个用例集、为什么选这些」——D7 的「为什么选这些记一句在 run metadata」。
const run = await createExperimentRun({
  projectID: project.id,
  datasetID: dataset.id,
  datasetVersion: Number.isInteger(dataset.current_version) ? dataset.current_version : null,
  name: EXPERIMENT,
  parentExperimentID: parent?.id ?? "",
  metadata: {
    ...(NOTES ? { notes: NOTES } : {}),
    agent: "claude-cli",
    model: MODEL || "default",
    prompt_source: ctx.source,
    dataset: DATASET,
    workdir_guidance: WORKDIR_TEMPLATE === "none" ? "off" : "on",
  },
});
ctx.runID = run.id;

// 轮次状态由这里收尾（飞轮设计 §13.2 #7）：此前从不写，跑完的轮次永远是 running，读侧分不清完没完。
// 取值同 DD：running / completed / failed / interrupted（server 按同一集合校验）。被 Ctrl-C / kill 打断就写 interrupted。
const settleStatus = async (status) => {
  try {
    await patchCPExperiment(run.id, { status });
  } catch (e) {
    console.error(`⚠ 写轮次状态 ${status} 失败：${e.message || e}`);
  }
};
for (const sig of ["SIGINT", "SIGTERM"]) {
  process.once(sig, () => {
    void settleStatus("interrupted").finally(() => process.exit(130));
  });
}
console.error(`run=${run.id} name=${run.name}（逻辑名 ${run.experiment ?? EXPERIMENT}；跑一次就是一条新 run，同名不复用旧行）${parent ? ` parent=${parent.id}` : ""}`);

// 每次运行独立 obs 目录（状态文件 + spans.jsonl 干净隔离）；mcp.json 全程共用一份。
const runDir = fs.mkdtempSync(path.join(os.tmpdir(), "llmobs-exp-"));
const obsDir = path.join(runDir, "obs");
fs.mkdirSync(obsDir, { recursive: true });
const mcpConfigPath = path.join(runDir, "mcp.json");
fs.writeFileSync(mcpConfigPath, JSON.stringify(buildMcpConfig(), null, 2));
ctx.obsDir = obsDir;
ctx.mcpConfigPath = mcpConfigPath;

const results = await runWorkerPool({
  items: records,
  concurrency: CONCURRENCY,
  runItem: (record, idx) => runOne(record, idx, ctx),
});

// hooks 落盘的 span（agent/llm/tool 全部客户端合成，2026-07-15 起）统一转发 server（Replacing 幂等；
// stop hook 自己也会按 DBDOG_OBS_REPORT_URL 上报，这里是兜底）。
const spansFile = path.join(obsDir, "spans.jsonl");
if (fs.existsSync(spansFile)) {
  const raw = fs.readFileSync(spansFile, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
  const spans = dedupSpans(raw);
  if (spans.length) {
    try {
      const via = await postSpans(spans);
      console.error(`spans: 经 ${via === "edge" ? "mcp 边缘口（与 hooks 同路，root 带 mcp 章）" : "server 直连（未配 DBDOG_OBS_REPORT_URL/API_KEY，root 无 mcp 章）"} 转发 ${spans.length} 条 ✓（本地 ${raw.length} 行，去重 ${raw.length - spans.length}）`);
    } catch (e) {
      console.error(`⚠ spans 转发失败（本地留底 ${spansFile}）：${e.message || e}`);
    }
  }
}

// ---- 汇总 ----
const okN = results.filter((r) => r.judged?.verdict === "ok").length;
const partN = results.filter((r) => r.judged?.verdict === "part").length;
const missN = results.filter((r) => r.judged?.verdict === "miss").length;
const errN = results.filter((r) => r.error).length;
const noTraceN = results.filter((r) => r.noTrace).length;
console.error("");
console.error(`== 结果：ok=${okN} part=${partN} miss=${missN} 失败=${errN} 无trace=${noTraceN}（共 ${results.length}）`);
for (const r of results.filter((x) => x.error)) console.error(`  ✗ [${r.label}] ${r.error}`);
for (const r of results.filter((x) => x.noTrace)) console.error(`  ✗ [${r.label}] 无 trace（分数不可信）`);
try {
  const summary = await getExperimentSummary(run.id);
  const js = summary?.metrics?.judge_score;
  if (js?.mean != null) console.error(`== server 汇总：judge_score mean=${js.mean.toFixed(3)} p50=${js.p50} (n=${js.count})`);
} catch { /* 汇总失败不影响退出码 */ }
console.error(`== 控制台：/llmobs/experiments?experiment_id=${run.id}（run 名 ${run.name}）`);
const failed = errN === results.length || noTraceN > 0;
// 全部挂了 = failed；否则 completed——单条挂了照实写在它自己的事件上（status=error），不拖累整轮
await settleStatus(errN === results.length ? "failed" : "completed");
console.error(failed ? "EXPERIMENT-RUN-FAILED" : "EXPERIMENT-RUN-DONE");
process.exit(failed ? 1 : 0);
