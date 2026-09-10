// judge.mjs — LLM-judge（eval 面 E2）：比对 agent 诊断结论 vs dataset 期望根因。
// 跑在 runner 侧（用户侧模型，headless claude -p），守 server ADR-0011：server 只存分不判分。
// 评分制沿用 e2e 人判词表（gen-rerun-analysis 的 ok/part/miss），score 归一到 1/0.5/0。
import { runAgentCli } from "../../e2e/lib/agent-cli.mjs";

const VERDICTS = new Set(["ok", "part", "miss"]);
const SCORE_OF = { ok: 1, part: 0.5, miss: 0 };

export function buildJudgePrompt({ expected, meta, prose, scenario }) {
  // 期望材料按可用性降级：显式 expected_roots > 故障注入描述（expected_output 或
  // metadata 里的 fault_injection）。基线（期望无故障）只认显式标记（slug=baseline），
  // 绝不因「期望材料为空」推断——空材料当成基线会把故障场景判反（2026-07-12 实测踩坑）。
  const rootsList = expected?.expected_roots ?? [];
  const behaviors = expected?.expected_behaviors ?? [];
  const fault = expected?.fault_injection || meta?.fault_injection || "";
  const isBaseline = String(meta?.slug ?? "") === "baseline" || /baseline/i.test(String(meta?.scenario_id ?? ""));
  let expectation;
  if (isBaseline) {
    expectation = "【期望】本场景为健康基线：期望 agent **不报任何故障根因**（谎报即 miss，正确说无故障即 ok）。";
  } else if (behaviors.length) {
    // 行为基准（时间无关的真实用例用这个）：判的是回答质量，不是事实精确匹配。
    expectation = `【行为基准（逐条对照，全满足=ok，部分满足=part，多数不满足或明显违反=miss）】\n${behaviors.map((b) => `- ${b}`).join("\n")}`;
  } else if (rootsList.length) {
    expectation = `【期望根因】\n${rootsList.map((r) => `- ${r}`).join("\n")}`;
  } else if (fault) {
    expectation = `【本场景实际注入的故障（判定基准）】\n${fault}\n（期望 agent 的根因结论与上述注入故障对应；未提及/说找不到问题即 miss。）`;
  } else {
    expectation = "【期望】（未提供期望材料——请按 reasoning 说明无法判定，verdict 给 miss）";
  }
  const phenomena = (expected?.expected_phenomena ?? []).length
    ? `\n【期望现象】\n${expected.expected_phenomena.map((p) => `- ${p}`).join("\n")}`
    : "";
  const notes = expected?.notes ? `\n场景设计备注：${expected.notes}` : "";
  return `你是数据库诊断评审。下面是一次诊断任务的「判定基准」与被评 agent 的「诊断结论全文」。
只输出一行 JSON，不要输出任何其他文字。

【场景】${scenario || "（未知）"}
${expectation}${phenomena}${notes}

【agent 诊断结论全文】
<<<
${prose}
>>>

判定规则：
- verdict="ok"：主结论命中判定基准（同义表述算命中），无重大误报；
- verdict="part"：方向正确但不完整/停在现象层，或夹带明显错误主张；
- verdict="miss"：未命中，或把健康场景谎报为故障。

输出格式（严格一行 JSON）：{"verdict":"ok|part|miss","reasoning":"一句话中文理由"}`;
}

export function parseJudgeOutput(text) {
  // 宽容解析：取第一个平衡的大括号块。
  const start = text.indexOf("{");
  if (start < 0) return null;
  for (let end = text.indexOf("}", start); end >= 0; end = text.indexOf("}", end + 1)) {
    try {
      const o = JSON.parse(text.slice(start, end + 1));
      if (o && VERDICTS.has(o.verdict)) {
        return { verdict: o.verdict, score: SCORE_OF[o.verdict], reasoning: String(o.reasoning ?? "").slice(0, 500) };
      }
    } catch { /* 继续扩大右界 */ }
  }
  return null;
}

/**
 * 判一条：headless claude -p（无 MCP、禁 hooks——judge 会话自身不产 trace），失败重试一次。
 * @returns {Promise<{verdict:string,score:number,reasoning:string}|{error:string}>}
 */
export async function judgeOne({ expected, meta, prose, scenario, model, timeoutMs = 180_000 }) {
  const prompt = buildJudgePrompt({ expected, meta, prose, scenario });
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      const res = await runAgentCli({
        prompt,
        model,
        captureTools: false,
        extraArgs: ["--settings", '{"disableAllHooks":true}', "--setting-sources", "project", "--disable-slash-commands"],
        timeoutMs,
      });
      const parsed = parseJudgeOutput(res.prose || "");
      if (parsed) return parsed;
    } catch (e) {
      if (attempt === 2) return { error: `judge 失败：${e.message || e}` };
    }
  }
  return { error: "judge 输出无法解析为 verdict JSON（重试后仍失败）" };
}

/**
 * 内置判官那两条 metric（跑批时挂在 event 上）。
 *
 * **label 是 `judge_verdict`，不是 `verdict`**：`verdict` 归判题投影（correct/partial/wrong，
 * `metric_source=annotation`）。两条同名 metric 并存时，server 的 `metricFor` 取第一条、
 * `statsFor` 的 metric_type 取最后一条而 count 把两条都数 ⇒ summary 双计、对比页的退步/修好
 * 会算到内置判官头上。内置判官是启发式，人判 / skill 判才叫 verdict（飞轮设计 §8 第 4 条）。
 * 事件的 `dimensions.verdict` 是另一回事，照旧（server 列表页的 ok/part/miss 读的是 dimensions）。
 */
export function judgeMetrics(judged) {
  if (judged?.error) {
    return [{ label: "judge_score", metric_type: "score", score_value: -1, metric_source: "llm_judge", error_message: judged.error }];
  }
  return [
    { label: "judge_score", metric_type: "score", score_value: judged.score, metric_source: "llm_judge", reasoning: judged.reasoning, assessment: judged.verdict },
    { label: "judge_verdict", metric_type: "categorical", categorical_value: judged.verdict, metric_source: "llm_judge" },
  ];
}
