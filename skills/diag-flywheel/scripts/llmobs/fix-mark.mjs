#!/usr/bin/env node
// fix-mark.mjs — 修的人给一条改进点打标记（飞轮设计 §13.3「修复标记」）。
//
// owner 2026-09-11：「一条一条列出来，大模型修复后可以给他们打上标记，比如是否修复了，是否需要人类协助」。
// 标记是**声明，不是判决**：它只说「我改了 / 我改不动 / 我不修」，修没修好仍由后续轮次的复验说了算——
// `claimed_fixed` 之后一轮复验 `still_open`，标记就被复验盖掉；复验 `fixed` 才算关。
//
// 用法：
//   node scripts/llmobs/fix-mark.mjs --trace <trace_id> --key <改进点 key> --status claimed_fixed|needs_human|wont_fix \
//     --note "改了什么 / 要人做什么 / 为什么不修" --by <谁：模型名或人名> [--project default-project]
//
//   --trace   挖出这条改进点的那次诊断（控制台待修卡片上的「修这一条」命令带着它）
//   --key     改进点的 key（跨轮次认同一个缺口的唯一依据）
//
// 落点：该 trace 在 diag-judge 队列里的 interaction 上，label `fix_marks`（json：`{ "<key>": {status, note, by, at} }`）。
// 先读回已有的 map 合并再写——label 值是整体覆盖的，不合并会把别的 key 的标记冲掉。
// server 收到后照常投影（json 对象只进 experiment metric，不上 root tag）。
//
// env 同 run-experiment（DBDOG_BASE_URL / DBDOG_API_KEY 或 DBDOG_INTERNAL_TOKEN / DBDOG_ORG）。
import {
  findProject, listAnnotationQueues, listAnnotationLabels, addAnnotationInteractions,
  findAllAnnotationsByContent, upsertAnnotations, requireCredential,
} from "./lib/exp-client.mjs";
import { FIX_KEY_RE, FIX_MARK_STATUSES, QUEUE_NAME } from "./lib/judge-package.mjs";

const argOf = (name, dflt) => {
  const i = process.argv.indexOf(name);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : dflt;
};
const fail = (m) => { console.error(`✗ ${m}`); process.exit(1); };

const TRACE = argOf("--trace", "");
const KEY = argOf("--key", "");
const STATUS = argOf("--status", "");
const NOTE = argOf("--note", "");
const BY = argOf("--by", "");
const PROJECT = argOf("--project", "default-project");

if (!TRACE) fail("--trace 必填（挖出这条改进点的那次诊断的 trace_id）");
if (!FIX_KEY_RE.test(KEY)) fail(`--key ${JSON.stringify(KEY)} 不合规（小写 ascii，<层>.<模块>.<缺什么>，照改进点卡片上的写）`);
if (!FIX_MARK_STATUSES.includes(STATUS)) fail(`--status 只能是 ${FIX_MARK_STATUSES.join(" / ")}`);
if (!NOTE.trim()) fail("--note 必填：改了什么 / 要人做什么 / 为什么不修——空标记没人看得懂");
if (!BY.trim()) fail("--by 必填：谁打的标记（模型名或人名）");
requireCredential();

const project = await findProject(PROJECT);
if (!project?.id) fail(`project 不存在：${PROJECT}`);
const queue = (await listAnnotationQueues({ projectID: project.id })).find((q) => q.name === QUEUE_NAME);
if (!queue) fail(`project ${PROJECT} 里没有判题队列 ${QUEUE_NAME}——这条 trace 还没判过，没有可标记的改进点`);
const queueID = queue.queue_id ?? queue.id;
const label = (await listAnnotationLabels(queueID)).find((l) => l.label === "fix_marks");
if (!label?.id) fail(`队列 ${QUEUE_NAME} 没有 fix_marks 这个 label——队列是 2026-09-11 之前建的，先按设计 §7.1 重建 label schema`);

// 这条 trace 现有的批注：核 key 真在这一次判题的改进点里，顺便读回已有的标记合并
const existing = (await findAllAnnotationsByContent([TRACE])).get(TRACE) ?? [];
const mine = existing.find((it) => String(it.queue_id ?? "") === String(queueID)) ?? existing[0] ?? null;
const labelsHere = new Map();
for (const an of mine?.annotations ?? []) if (an.label && !labelsHere.has(an.label)) labelsHere.set(an.label, an.value);
let findings = labelsHere.get("findings");
if (typeof findings === "string") { try { findings = JSON.parse(findings); } catch { findings = null; } }
const keysHere = new Set([...(findings?.items ?? []).map((it) => it?.key), ...(findings?.checks ?? []).map((c) => c?.key)].filter(Boolean));
if (!keysHere.has(KEY)) {
  console.error(`⚠ 这次判题（trace ${TRACE.slice(0, 8)}…）的改进点里没有 ${KEY}（有的是：${[...keysHere].join(", ") || "无"}）——照样写，但核一眼 trace 是不是给错了`);
}
let marks = labelsHere.get("fix_marks") ?? {};
if (typeof marks === "string") { try { marks = JSON.parse(marks); } catch { marks = {}; } }
if (!marks || typeof marks !== "object" || Array.isArray(marks)) marks = {};

const [interaction] = await addAnnotationInteractions(queueID, [{ content_id: TRACE, content_kind: "trace" }]);
if (!interaction?.id) fail("排队后没拿到 interaction id");
const at = new Date().toISOString();
const next = { ...marks, [KEY]: { status: STATUS, note: NOTE.trim(), by: BY.trim(), at } };
await upsertAnnotations([{ interaction_id: interaction.id, label_id: label.id, value: next, annotator: BY.trim() }]);
console.error(`✓ ${KEY} ← ${STATUS}（${BY}，${at}）`);
console.error(STATUS === "claimed_fixed"
  ? "  关不关看复验：重跑挖出它的那道题、判那一轮，复验是「修好了」才算关"
  : STATUS === "needs_human"
    ? "  控制台待修卡片会显示「要人协助」并带上这条 note"
    : "  控制台待修卡片会显示「不修」并带上理由");
