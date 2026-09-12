// agreement.mjs —— 判题一致性：同一批 trace 判两遍，两遍之间有多像。
//
// ## 为什么这张表比再加十条 rubric 规则更值钱
//
// 分类体系是不是写清楚了，唯一的检验是**两个判官（或同一判官两次）判得像不像**。MAST 那份
// 14 类的多智能体失败分类，是靠人工双标 + Cohen's κ=0.88 验收的；我们这套五类（现六类）
// 从来没量过——于是「该改哪一类的定义」只能靠读感排优先级。κ 低的那一类就是定义最糊的那一类。
//
// ## 三件事分开报，不合成一个数
//
// · `verdict` / `evidence`：分类一致性，用 Cohen's κ（扣掉「瞎猜也能蒙对」的那部分）；
// · 改进点类别：判官提的条目本来就不会一一对应，所以不按条配对，按**这一例提到了哪些类别**
//   算集合重合度（Jaccard）；
// · **弃判率两边各报各的**：它不是一致率的一部分。两边都不敢判，一致率会很好看，
//   但那说明的是「判不动」，不是「判得准」——rubric 判题的一致性测量惯例也要求单列。
//
// κ 的两个坑都照直说，不糊弄：两边全填同一个值时 pe=1、κ 没有定义（回 null）；小样本上 κ 极不稳。
import { normalizeFindings, deriveAbstention } from "./judge-package.mjs";

/**
 * Cohen's κ。`pairs` 是 [[甲的判, 乙的判], …]，取值任意（字符串比较）。
 * @returns {{kappa:number|null, observed:number|null, expected:number|null, n:number, note?:string}}
 */
export function cohensKappa(pairs) {
  const rows = (pairs ?? []).filter((p) => Array.isArray(p) && p.length === 2 && p[0] != null && p[1] != null);
  const n = rows.length;
  if (n === 0) return { kappa: null, observed: null, expected: null, n: 0, note: "没有可配对的样本" };

  let agree = 0;
  const ca = new Map(); const cb = new Map();
  for (const [a, b] of rows) {
    if (String(a) === String(b)) agree += 1;
    ca.set(String(a), (ca.get(String(a)) ?? 0) + 1);
    cb.set(String(b), (cb.get(String(b)) ?? 0) + 1);
  }
  const observed = agree / n;
  let expected = 0;
  for (const [v, k] of ca) expected += (k / n) * ((cb.get(v) ?? 0) / n);

  if (expected >= 1) {
    // 两边都只用了同一个取值：pe=1，κ = 0/0。这时 κ 不是 1 也不是 0，它没有定义——
    // 报 null 并说明，比填一个看着像答案的数强。
    return { kappa: null, observed, expected, n, note: "两边都只有一个取值，κ 没有定义（pe=1）" };
  }
  const kappa = (observed - expected) / (1 - expected);
  return { kappa, observed, expected, n, ...(n < 20 ? { note: `样本只有 ${n} 例，κ 在小样本上极不稳，只当参考` } : {}) };
}

const kindSetOf = (labels) => {
  const { items } = normalizeFindings(labels?.findings);
  return new Set(items.map((it) => it?.kind).filter((k) => k && k !== "unsure"));
};

/** 两边都空时回 null：那是「这一例谁都没提改进点」，算成 1.0 会把判不出来美化成完全一致。 */
const jaccard = (a, b) => {
  if (a.size === 0 && b.size === 0) return null;
  let inter = 0;
  for (const v of a) if (b.has(v)) inter += 1;
  return inter / (a.size + b.size - inter);
};

const abstentionRate = (rows) => {
  let items = 0; let abstained = 0;
  for (const r of rows) {
    items += normalizeFindings(r?.labels?.findings).items.length;
    abstained += deriveAbstention(r?.labels?.findings).count;
  }
  return items === 0 ? 0 : abstained / items;
};

/**
 * 两轮（或两个判官）的判题对照。入参是两组 `{trace_id, labels}`（`annotations.jsonl` 的行形状）。
 * 只对**两边都判过**的那些 trace；各自独有的单列，因为「没判」和「判得不一样」是两件事。
 */
export function agreementReport(rowsA, rowsB) {
  const byA = new Map((rowsA ?? []).filter((r) => r?.trace_id).map((r) => [String(r.trace_id), r]));
  const byB = new Map((rowsB ?? []).filter((r) => r?.trace_id).map((r) => [String(r.trace_id), r]));
  const shared = [...byA.keys()].filter((t) => byB.has(t));

  const verdictPairs = [];
  const evidencePairs = [];
  const jaccards = [];
  let bothEmpty = 0;   // 两边都没提改进点的例子：单独数，不混进平均
  for (const t of shared) {
    const a = byA.get(t).labels ?? {}; const b = byB.get(t).labels ?? {};
    if (a.verdict != null && b.verdict != null) verdictPairs.push([a.verdict, b.verdict]);
    if (a.evidence != null && b.evidence != null) evidencePairs.push([a.evidence, b.evidence]);
    const j = jaccard(kindSetOf(a), kindSetOf(b));
    if (j === null) bothEmpty += 1; else jaccards.push(j);
  }

  return {
    paired: shared.length,
    only_a: [...byA.keys()].filter((t) => !byB.has(t)),
    only_b: [...byB.keys()].filter((t) => !byA.has(t)),
    verdict: cohensKappa(verdictPairs),
    evidence: cohensKappa(evidencePairs),
    kinds: {
      jaccard: jaccards.length ? jaccards.reduce((x, y) => x + y, 0) / jaccards.length : null,
      n: jaccards.length,
      both_empty: bothEmpty,
    },
    abstention: {
      a: abstentionRate(shared.map((t) => byA.get(t))),
      b: abstentionRate(shared.map((t) => byB.get(t))),
    },
  };
}
