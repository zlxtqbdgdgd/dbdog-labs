#!/usr/bin/env node
// curate-record.mjs — 把一个用例沉淀进 llmobs dataset（eval 面 E3，飞轮的「沉淀」步）。
// DD 对应物：datadog/llm-obs-curate-dataset-records skill（从复盘一键入集）。
//
// 两种来源：
//   ① 从真实 trace 沉淀：--trace <trace_id> 拉 root span，input=当时的问题，
//      当时的结论存进 metadata.observed_output（参照物）；expected 由你补。
//   ② 直接构造：--prompt "<问题>"。
//
// 期望材料（judge 的判定基准，三选一）：
//   --behaviors "a;b;c"   行为基准（时间无关用例推荐：判回答质量，不判事实精确匹配）
//   --roots "a;b"         期望根因清单
//   --notes "…"           附注（可与上两者并用）
//
// 用法：
//   node scripts/llmobs/curate-record.mjs --dataset daily-diag --prompt "最近30分钟数据库整体正常吗?" \
//     --behaviors "健康时明确说健康;不得把历史遗留问题报成当前故障;每个结论给指标证据" \
//     --tags kind:checkup --create-dataset "日常诊断行为基准"
//
// env 同 run-experiment（DBDOG_BASE_URL / DBDOG_API_KEY 或 DBDOG_INTERNAL_TOKEN / DBDOG_ORG）。
import {
  call, loadDataset, baseUrl,
  findProject, createProject, createDataset, addRecords,
  requireCredential,
} from "./lib/exp-client.mjs";

const argOf = (name, dflt) => {
  const i = process.argv.indexOf(name);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : dflt;
};
const list = (s) => String(s || "").split(";").map((x) => x.trim()).filter(Boolean);
const fail = (m) => { console.error(`✗ ${m}`); process.exit(1); };

const PROJECT = argOf("--project", "default-project");
const DATASET = argOf("--dataset", "");
const TRACE = argOf("--trace", "");
const PROMPT = argOf("--prompt", "");
const BEHAVIORS = list(argOf("--behaviors", ""));
const ROOTS = list(argOf("--roots", ""));
const NOTES = argOf("--notes", "");
const TAGS = list(argOf("--tags", "")).length ? list(argOf("--tags", "")) : [];
const CREATE_DESC = argOf("--create-dataset", "");

if (!DATASET) fail("--dataset 必填");
if (!TRACE && !PROMPT) fail("--trace 或 --prompt 至少给一个");
if (!BEHAVIORS.length && !ROOTS.length) fail("--behaviors 或 --roots 至少给一个（judge 的判定基准）");
requireCredential();

// 来源 ①：从 trace 取 input/observed_output。
let prompt = PROMPT, observed = null, sourceTrace = null;
if (TRACE) {
  const t = await call("GET", `/api/v2/llmobs/trace/${encodeURIComponent(TRACE)}`);
  if (t?.status === "not_found") fail(`trace 不在库中：${TRACE}`);
  const root = (t.spans ?? []).find((s) => !s.parent_id && s.kind === "agent");
  if (!root) fail("trace 无 agent root span");
  prompt = PROMPT || root.input || "";
  observed = root.output || null;
  sourceTrace = TRACE;
  if (!prompt) fail("root span 无 input，请用 --prompt 显式给问题");
}

// project/dataset 解析（dataset 不存在且给了 --create-dataset 则建）。
let project, dataset;
try {
  ({ project, dataset } = await loadDataset({ projectName: PROJECT, datasetName: DATASET }));
} catch (e) {
  if (!CREATE_DESC) fail(`${e.message}（加 --create-dataset "<描述>" 可自动创建）`);
  project = await findProject(PROJECT)
    ?? await createProject(PROJECT, "dbdog llmobs 实验默认项目");
  dataset = await createDataset(project.id, DATASET, CREATE_DESC);
  console.error(`dataset 新建：${dataset.name} (${dataset.id})`);
}

const record = {
  input: { prompt },
  expected_output: {
    ...(BEHAVIORS.length ? { expected_behaviors: BEHAVIORS } : {}),
    ...(ROOTS.length ? { expected_roots: ROOTS } : {}),
    ...(NOTES ? { notes: NOTES } : {}),
  },
  metadata: {
    curated_at: new Date().toISOString(),
    ...(sourceTrace ? { source_trace: sourceTrace, observed_output: String(observed ?? "").slice(0, 8000) } : {}),
  },
  tags: TAGS,
};
const [created] = await addRecords(project.id, dataset.id, [record]);
if (!created?.id) fail("record 创建失败：响应无 id");
console.error(`✓ record ${created.id} → dataset ${dataset.name}（server ${baseUrl()}）`);
console.log(created.id);
