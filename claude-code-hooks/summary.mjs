// summary.mjs — 诊断流程总结：裁剪 + 提示词 + 调本地大模型（lib，零依赖 MJS）。
// 设计：dbdog-web/docs/design/llmobs-investigation-narrative.md（hook 侧 detach 生成）。
// 由 summary-worker.mjs（detached）调用，**不在 Stop 关键路径同步执行**——Stop 只 spawn worker。
//
// 裁剪（Y 方案）同时服务「省 token」与「去噪」——占 token 的（重复、逐字 dump、空转推理）
// 正好就是干扰叙事的噪音。只保三类硬证据：MCP 工具（按 intent 归组留信号行）、
// Read/Grep/Bash（通用代码 token）、agent 结论。llm 与管理/改动工具全丢。
// 起承转折不靠代码硬判定，交给本地大模型按提示词写——换个诊断形状不会塌。

// ---------- env ----------

// 取首个"真实"值——空串与占位（change-me / <…> / ABSOLUTE/PATH）一律视同未设，继续看下一个。
// 让 DBDOG_SUMMARY_LLM_* 占位能自动回退到 ANTHROPIC_*，而不是卡死在占位字面量上。
function firstReal(...vals) {
  for (const v of vals) {
    const s = (v ?? "").trim();
    if (!s) continue;
    if (s.startsWith("change-me") || s.startsWith("<") || s.includes("ABSOLUTE/PATH")) continue;
    return s;
  }
  return "";
}

// 剥离尾部 [1m] 之类的 Claude Code 路由后缀——裸模型 API 不认（实测 HTTP 400）。
function stripModelSuffix(m) {
  return (m || "").replace(/\[[^\]]*\]$/, "");
}

// 按 baseUrl 的 host 选默认模型：bigmodel→glm-5.2、anthropic.com→claude-haiku-4-5；未识别返回 ""。
function defaultModelFor(baseUrl) {
  let host = "";
  try {
    host = new URL(baseUrl).host;
  } catch {
    host = "";
  }
  if (host.includes("bigmodel.cn")) return "glm-5.2";
  if (host.includes("anthropic.com")) return "claude-haiku-4-5";
  return "";
}

/**
 * 解析诊断总结的 LLM 端点配置。
 *
 * 每段都先取 DBDOG_SUMMARY_LLM_*（显式覆盖），缺/占位则回退到 Claude Code 自身的 ANTHROPIC_*：
 *   baseUrl: DBDOG_SUMMARY_LLM_BASE_URL → ANTHROPIC_BASE_URL → ANTHROPIC_API_URL → "https://api.anthropic.com"
 *   apiKey:  DBDOG_SUMMARY_LLM_API_KEY  → ANTHROPIC_AUTH_TOKEN → ANTHROPIC_API_KEY
 *   model:   DBDOG_SUMMARY_LLM_MODEL → ANTHROPIC_MODEL（均剥 [路由后缀]）→ 按 baseUrl host 判定默认
 *
 * 回退到 ANTHROPIC_* 是为"零额外配置出总结"——Claude Code 本就跑在某个 Anthropic-Messages 兼容
 * 端点上、凭据已在 env 里，复用比让用户再抄一份更稳（避免 token 轮换两处不同步）。请求走
 * Anthropic Messages 协议（见 generateSummary），与 Claude Code 端点天然兼容。
 *
 * apiKey 最终解析值缺失 → 返回 null（不出总结，但不报错）。host 未识别且未显式指定 model →
 * 兜底 glm-5.2 并 stderr 提示（让用户知道可设 DBDOG_SUMMARY_LLM_MODEL 覆盖）。
 */
export function summaryEnv() {
  const baseUrl =
    firstReal(
      process.env.DBDOG_SUMMARY_LLM_BASE_URL,
      process.env.ANTHROPIC_BASE_URL,
      process.env.ANTHROPIC_API_URL,
    ) || "https://api.anthropic.com";
  const apiKey = firstReal(
    process.env.DBDOG_SUMMARY_LLM_API_KEY,
    process.env.ANTHROPIC_AUTH_TOKEN,
    process.env.ANTHROPIC_API_KEY,
  );
  if (!apiKey) return null;

  const explicitModel = stripModelSuffix(
    firstReal(process.env.DBDOG_SUMMARY_LLM_MODEL, process.env.ANTHROPIC_MODEL),
  );
  const fallbackModel = defaultModelFor(baseUrl);
  const model = explicitModel || fallbackModel || "glm-5.2";
  if (!explicitModel && !fallbackModel) {
    console.error(
      "[dbdog-obs] 未识别总结端点 host，默认用 glm-5.2；不对请设 DBDOG_SUMMARY_LLM_MODEL",
    );
  }
  const timeoutMs = Number(process.env.DBDOG_SUMMARY_LLM_TIMEOUT_MS) || 30_000;
  // 输出预算(2026-08-14 提到 2048):实测 deepseek-v4-flash 一段合格总结 1194 output
  // tokens,旧值 1024 连直答都会拦腰截断;推理模型的 thinking 另行关闭(见 generateSummary)。
  const maxTokens = Number(process.env.DBDOG_SUMMARY_LLM_MAX_TOKENS) || 2048;
  return { baseUrl, apiKey, model, timeoutMs, maxTokens };
}

// ---------- 裁剪 ----------

const CODE_TOOLS = new Set(["Read", "Grep", "Bash"]);
const SUBAGENT_SPAWNERS = new Set(["Agent", "Task"]);

const TOOL_OUT_BUDGET = 500;
const CODE_OUT_BUDGET = 400;
const AGENT_ROOT_BUDGET = 3000;
const AGENT_SUB_BUDGET = 600;
const MAX_PROMPT_CHARS = 48_000;

// MCP 工具 output 信号行：含数字 / error / 命中数——req-3「返回 具体数值」的依据
const SIGNAL_RE =
  /\d|error|fail|denied|refus|timeout|超时|错误|拒绝|命中\s*0|0\s*(hits|rows|条|结果|matches|samples)/i;
// 代码证据行：文件路径 / 行号引用 / -> / :: / 函数调用式——req-3「读取 文件/方法 确认」的依据
const PATH_RE = /[\w./-]+\.[A-Za-z]{1,6}(?::\d+)?/;
const CODE_SYM_RE = /->|::|\bfn\b|\bfunc\b|\bdef\b|\bclass\b|[A-Za-z_]\w*\s*\(/;

function clipRaw(text, max) {
  const t = text.replace(/\r\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
  if (!t) return "";
  return t.length <= max ? t : `${t.slice(0, max - 1)}…`;
}

/** 取头尾各 2 行 + 命中式行（去重、保序），上限 max；无命中则 clipRaw 头尾。 */
function pickLines(text, isKeep, max, signalCap = 16) {
  const lines = text.replace(/\r\n/g, "\n").split("\n");
  const keep = new Set();
  for (const i of [0, 1, lines.length - 2, lines.length - 1]) {
    if (i >= 0 && i < lines.length) keep.add(i);
  }
  let added = 0;
  lines.forEach((l, i) => {
    if (added < signalCap && isKeep(l)) {
      keep.add(i);
      added++;
    }
  });
  const out = [...keep]
    .sort((a, b) => a - b)
    .map((i) => lines[i])
    .join("\n")
    .trim();
  return out ? clipRaw(out, max) : clipRaw(text, max);
}

function shortTool(name) {
  const n = (name ?? "").trim();
  if (!n) return "工具";
  const parts = n.split(/[./]/);
  return parts[parts.length - 1] || n;
}

/**
 * 把本 trace 的 span 裁成喂给本地大模型的事实表（字符串）。
 * span 形如 stop.mjs 写进 spans.jsonl 的结构：kind/name/status/input/output/intent/tags。
 */
export function trimSpans(spans) {
  const sorted = [...spans].sort((a, b) => (a.ts ?? 0) - (b.ts ?? 0) || String(a.span_id).localeCompare(String(b.span_id)));
  const llmCount = sorted.filter((s) => s.kind === "llm").length;
  const toolCount = sorted.filter((s) => s.kind === "tool").length;
  const errCount = sorted.filter((s) => /error|err|fail/i.test(s.status ?? "")).length;

  // agent 结论：root（无 parent 或 kind=agent 且非子代理）整段，子代理结论各留小段
  const agents = sorted.filter((s) => s.kind === "agent");
  const rootAgent = agents.find((s) => !s.parent_id) ?? agents[0];
  const subAgents = agents.filter((a) => a !== rootAgent);

  // MCP 工具按 intent 归组
  const mcpTools = sorted.filter((s) => s.kind === "tool" && s.tags?.mcp_server);
  const byIntent = new Map(); // intent -> [{ span, name }]
  for (const t of mcpTools) {
    const intent = (t.intent ?? "").trim() || "(无 intent)";
    if (!byIntent.has(intent)) byIntent.set(intent, []);
    byIntent.get(intent).push(t);
  }

  // 代码工具
  const codeTools = sorted.filter((s) => s.kind === "tool" && CODE_TOOLS.has(s.name));

  // ---- 序列化 ----
  const head = [
    "诊断事实表（仅含裁剪后的 span 证据，数字均来自本次 trace）：",
    `- 推理轮（llm span）：${llmCount}`,
    `- 工具调用（tool span）：${toolCount}`,
    `- 出错 span：${errCount}`,
  ];

  const blocks = [];

  // agent 结论
  const concl = [];
  if (rootAgent?.output) concl.push(`[root 结论] ${clipRaw(rootAgent.output, AGENT_ROOT_BUDGET)}`);
  for (const a of subAgents.slice(0, 6)) {
    if (a.output) concl.push(`[子代理结论] ${clipRaw(a.output, AGENT_SUB_BUDGET)}`);
  }
  if (concl.length) blocks.push("agent 结论：\n" + concl.join("\n"));

  // MCP 工具证据（按 intent 分组）
  if (byIntent.size) {
    const lines = ["MCP 工具证据（按 intent 分组，留信号行）："];
    for (const [intent, group] of byIntent) {
      const names = [...new Set(group.map((g) => shortTool(g.name)))].slice(0, 4).join(" / ");
      const signals = group
        .map((g) => pickLines(g.output ?? "", (l) => SIGNAL_RE.test(l), TOOL_OUT_BUDGET))
        .filter(Boolean);
      const joined = clipRaw(signals.join(" | "), TOOL_OUT_BUDGET);
      lines.push(`  [intent: ${intent}] ${names}${joined ? `\n    ${joined}` : ""}`);
    }
    blocks.push(lines.join("\n"));
  }

  // 代码证据
  if (codeTools.length) {
    const lines = ["代码证据（Read/Grep/Bash，留代码行）："];
    for (const c of codeTools.slice(0, 20)) {
      const tgt = c.input ? clipRaw(c.input, 80) : "";
      const body = pickLines(c.output ?? "", (l) => PATH_RE.test(l) || CODE_SYM_RE.test(l) || /:\d+:/.test(l), CODE_OUT_BUDGET);
      lines.push(`  ${c.name}${tgt ? ` ${tgt}` : ""}${body ? `\n    ${body}` : ""}`);
    }
    blocks.push(lines.join("\n"));
  }

  const body = blocks.join("\n\n");
  let out = `${head.join("\n")}\n\n${body}`;
  if (out.length > MAX_PROMPT_CHARS) out = out.slice(0, MAX_PROMPT_CHARS - 1) + "…（已达上限，已截断）";
  return out;
}

// ---------- 提示词 ----------

export const SYSTEM_PROMPT = `你是一个可观测性诊断助手，使用 Dbdog MCP 工具进行问题调查。当完成一次调查后，将整个过程压缩一下，总结提炼诊断过程，写作规则如下：
1. 用一句话交代背景（实例、库、表、问题 SQL 或服务、接口）
2. 只在推理链的关键节点写明 MCP 工具名和指标名——即那些改变调查方向、确认或排除假设的步骤，格式为：通过 \`工具名\` 查询 \`指标名\` 返回 **具体数值**，关键证据或方向性转折处的数据用加粗标记，普通的补充性查询只需自然地引用数据结果，无需标注工具名或加粗
3. 如果调查过程中通过代码分析获取了关键证据（如读取源码、堆栈帧、配置文件等），同样在关键节点中点出来，格式为：读取 \`文件名/类名/方法名\` 确认 **具体代码行为或配置值**
4. 每个关键数据引出下一步推理，用自然因果语言串联（如"说明…"、"随即查…"、"但…返回…排除了…"、"因此锁定为…"）
5. 不使用"起·承·转·合"等标注性词语，靠叙事逻辑本身体现推理链
6. 用加粗标出一句话根因结论
7. 整体叙事应体现 Dbdog 产品从指标发现、假设验证、代码溯源到根因定位的系统化诊断能力，让读者感受到可观测性与代码分析的完整闭环

约束：
- 全部内容在一个段落内完成，不使用分点、编号、表格或标题
- 每个论断必须有数据或代码证据支撑，不说"可能""也许"
- 因果关系用自然语言串联，不附加工具清单或可执行建议`;

export function buildPrompt(factTable) {
  return [
    { role: "system", content: SYSTEM_PROMPT },
    { role: "user", content: factTable },
  ];
}

// ---------- 调本地大模型 ----------

/**
 * Anthropic Messages 协议（plain fetch，无 SDK）。
 * GLM Coding Plan 走 ${BASE_URL}/v1/messages（base 用 https://open.bigmodel.cn/api/anthropic）。
 * system 放顶层字段，max_tokens 必填，响应从 content[].text 取。失败抛 Error（上层 best-effort 吞）。
 *
 * 推理模型兼容（2026-08-14，47 圈巡检 45 圈无总结的根因）：deepseek-v4 系经 Anthropic
 * 兼容端点是推理模型——thinking 块先行，1024 的预算全被 thinking 烧光，text 一个字没出
 * 就 stop_reason=max_tokens，「空 content」把 worker 静默弄死；加大预算没用（实测 4096
 * 时 thinking 涨到 7761 字符，text 仍为 0，模型把 thinking 撑满给多少烧多少）。
 * 根治是请求里显式 thinking:{type:"disabled"}（Anthropic 协议标准字段，实测 deepseek
 * 端点认，直接 end_turn 出正文）。个别老兼容端点可能不认该字段而 4xx——去掉它重试一次，
 * 行为退回 0.4.4（非推理模型本来就不需要）。
 */
export async function generateSummary(messages, env) {
  const url = `${env.baseUrl.replace(/\/+$/, "")}/v1/messages`;
  const system = messages.find((m) => m.role === "system")?.content;
  const turns = messages.filter((m) => m.role !== "system");
  const base = {
    model: env.model,
    max_tokens: env.maxTokens ?? 2048,
    temperature: 0.2,
    ...(system ? { system } : {}),
    messages: turns,
  };
  const post = (body) =>
    fetch(url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${env.apiKey}`,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(env.timeoutMs),
    });

  let res = await post({ ...base, thinking: { type: "disabled" } });
  if (!res.ok && res.status === 400) {
    // 老兼容端点不认 thinking 字段 → 去掉重试一次（幂等只读调用，重试无副作用）。
    // 只对 400（bad request，"不认这个字段"一类）：401/403 重试无意义，
    // 429 重试是给限流火上浇油（codex 复审反例:双发）。
    res = await post(base);
  }
  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    throw new Error(`LLM HTTP ${res.status}: ${detail.slice(0, 300)}`);
  }
  const data = await res.json();
  const text = (data?.content ?? [])
    .filter((b) => b.type === "text")
    .map((b) => b.text ?? "")
    .join("")
    .trim();
  if (!text) {
    // 说清截停原因与块型——「空 content」三个字曾让 45 圈的死因整整藏了两天
    const blocks = (data?.content ?? []).map((b) => b?.type ?? "?").join(",") || "(无)";
    throw new Error(`LLM 无 text 输出：stop_reason=${data?.stop_reason ?? "?"}，content 块=[${blocks}]`);
  }
  return {
    text,
    model: env.model,
    tokens_input: data?.usage?.input_tokens ?? null,
    tokens_output: data?.usage?.output_tokens ?? null,
  };
}
