#!/usr/bin/env node
// case-history.mjs — 一道题之前几轮的判题（改进点 items、复验 checks、修复标记 fix_marks），给**取数判题**做复验用。
//
// 判题跟着轮次走（飞轮设计 §13）：一道题会跑很多轮，某一轮提的改进点修没修好，
// 由后续轮次的判题逐条复验说了算，不由人标。判下一轮之前，判题方要先拿到这道题之前几轮提过的条目——
// 包判题读包里的 `cases/<event_id>/prior-judgments.json`，取数判题跑这个脚本，两者同一个形状。
//
// 用法：
//   node scripts/llmobs/case-history.mjs --record <record_id> [--before <trace_id>] [--project default-project] [--open]
//
//   --before  只要这条 trace 所在那一轮**之前**的轮次（判哪一轮就传那一轮的 trace）；不给 = 全部轮次
//   --open    不出全量历史，只出**这一轮该逐条复验的清单**（还没关的条目）。
//             rubric 那条「哪些算还没关」的规则（最后一次有效复验不是 fixed、skill 类要连续两轮、
//             model 只计次）原先要判官自己在几十条历史里手算，漏一条没人拦得住——现在由代码给出。
//
// env 同 run-experiment（DBDOG_BASE_URL / DBDOG_API_KEY 或 DBDOG_INTERNAL_TOKEN / DBDOG_ORG）。
// 输出：stdout 一个 JSON 数组，旧的在前；空数组 = 这道题之前没判过，checks 省略。
import { findProject, findAllAnnotationsByContent, requireCredential } from "./lib/exp-client.mjs";
import { runsOfRecords } from "./lib/dataset-traces.mjs";
import { priorJudgments } from "./lib/judge-package.mjs";
import { openFindings } from "./lib/judge-quality.mjs";

const argOf = (name, dflt) => {
  const i = process.argv.indexOf(name);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : dflt;
};
const fail = (m) => { console.error(`✗ ${m}`); process.exit(1); };

const RECORD = argOf("--record", "");
const BEFORE = argOf("--before", "");
const PROJECT = argOf("--project", "default-project");
const ONLY_OPEN = process.argv.includes("--open");
if (!RECORD) fail("--record 必填（用例的 record id）");
requireCredential();

const project = await findProject(PROJECT);
if (!project?.id) fail(`project 不存在：${PROJECT}`);
const runs = (await runsOfRecords({ projectID: project.id, recordIDs: [RECORD] })).get(RECORD) ?? [];
const cutoff = BEFORE ? runs.find((r) => r.traceId === BEFORE)?.experimentCreatedAt : "";
if (BEFORE && !cutoff) fail(`--before ${BEFORE} 不是这道题的任何一次运行`);
const prior = runs.filter((r) => r.traceId && (!cutoff || r.experimentCreatedAt < cutoff));
const interactions = await findAllAnnotationsByContent(prior.map((r) => r.traceId));
const out = priorJudgments(
  prior.map((r) => ({ experiment: { id: r.experimentId, name: r.experimentName, created_at: r.experimentCreatedAt }, traceId: r.traceId })),
  interactions,
);
process.stdout.write(`${JSON.stringify(ONLY_OPEN ? openFindings(out) : out, null, 1)}\n`);
