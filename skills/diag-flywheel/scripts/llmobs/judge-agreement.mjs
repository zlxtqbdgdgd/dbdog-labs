#!/usr/bin/env node
// judge-agreement.mjs — 同一批 trace 判两遍，量两遍之间有多像（Cohen's κ）。
//
// ## 这是改 rubric 之前该先跑的那一步
//
// 分类体系写没写清，唯一的检验是两个判官（或同一判官两次）判得像不像。MAST 那份 14 类的
// 多智能体失败分类是靠人工双标 + κ=0.88 验收的；我们这套从来没量过，于是「该改哪一类的定义」
// 只能靠读感排。**κ 低的那一类就是定义最糊的那一类**，先量再改，比一次性改十条稳。
//
// 怎么产生第二份判题：同一批包判两遍（第二遍加 `--keep-package` 留住目录），或换一个判官模型判一遍。
// 两份都是 `annotations.jsonl` 的行形状，本脚本按 trace_id 配对。
//
// 用法：
//   node scripts/llmobs/judge-agreement.mjs --a <包目录|annotations.jsonl> --b <同左>
//
// 输出：stdout 一个 JSON（verdict / evidence 各一份 κ、改进点类别的集合重合度、两边各自的弃判率）。
// 判读：κ ≥ 0.8 很好；0.6–0.8 尚可；< 0.6 就是那一轴的定义没写清——去改 rubric 的那一节，别改判官。
import fs from "node:fs";
import path from "node:path";
import { parseAnnotationsJsonl } from "./lib/judge-package.mjs";
import { agreementReport } from "./lib/agreement.mjs";

const argOf = (n, d) => { const i = process.argv.indexOf(n); return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : d; };
const fail = (m) => { console.error(`✗ ${m}`); process.exit(1); };

const load = (p, which) => {
  if (!p) fail(`--${which} 必填（判题包目录，或包里的 annotations.jsonl）`);
  // 先看在不在：statSync 对不存在的路径直接抛裸栈，而「路径写错了」正是最常见的那一种错
  if (!fs.existsSync(p)) fail(`--${which} 指的 ${p} 不存在`);
  const file = fs.statSync(p).isDirectory() ? path.join(p, "annotations.jsonl") : p;
  if (!fs.existsSync(file)) fail(`${file} 不存在（这个目录像判题包，但里面没有 annotations.jsonl——那一包还没判）`);
  const { rows, problems } = parseAnnotationsJsonl(fs.readFileSync(file, "utf8"));
  // 坏行照报不静默吞：拿一份缺了几行的材料算一致性，算出来的数没有意义
  for (const x of problems) console.error(`⚠ ${which}: ${x}`);
  if (!rows.length) fail(`${file} 里没有一行可用记录`);
  return rows;
};

const report = agreementReport(load(argOf("--a", ""), "a"), load(argOf("--b", ""), "b"));
if (report.paired === 0) fail("两份判题没有一条 trace 是重合的——一致性无从谈起（是不是判的不是同一批？）");
process.stdout.write(`${JSON.stringify(report, null, 1)}\n`);

const line = (name, r) => `· ${name}：κ=${r.kappa === null ? "—" : r.kappa.toFixed(3)} 一致率=${(r.observed ?? 0).toFixed(3)} n=${r.n}${r.note ? `（${r.note}）` : ""}`;
console.error(`\n配对 ${report.paired} 例（只 a 有 ${report.only_a.length} · 只 b 有 ${report.only_b.length}）`);
console.error(line("verdict", report.verdict));
console.error(line("evidence", report.evidence));
console.error(`· 改进点类别重合度：${report.kinds.jaccard === null ? "—" : report.kinds.jaccard.toFixed(3)}（按 ${report.kinds.n} 例算${report.kinds.both_empty ? `；另有 ${report.kinds.both_empty} 例两边都没提改进点，没算进去` : ""}）`);
console.error(`· 弃判率：a ${(report.abstention.a * 100).toFixed(1)}% · b ${(report.abstention.b * 100).toFixed(1)}%（单列：两边都不敢判也能凑出很像的一致率）`);
