// judge-quality.mjs —— 判官自己的质量，以及「哪些条目还没关」这张清单。
//
// ## 为什么把「还没关」做成代码
//
// rubric 里那条规则（最后一次有效复验不是 `fixed` 就算没关；`skill` 类非确定性、要连续两轮；
// `model` 类不复验只计次）原先要判官**自己在几十条历史里跑一遍状态机**，而校验器只查每条 check
// 的形状、不查覆盖率——漏三条没人拦得住，页面上那三个缺口就一直开着，分不清是「真没修好」
// 还是「这轮忘了验」。规则就一句话，跑它的却是人：这正是该由代码兜的事（军规 3）。
//
// ## 为什么要量无效条目率
//
// Tricorder（Google 的静态分析平台）的经验：误报率一过 ~10%，开发者就整体不看了。我们有现成的
// 投票——修的人打的 `wont_fix`。不量它，「这一轮挖出 N 条」只奖励产量；量了，才是奖励有效性。
// 弃判率同理要单列：两边都不敢判也能凑出很好看的产量。
//
// 入参统一是 `priorJudgments()` / `case-history.mjs` 的那个形状（旧的在前）：
//   `[{round, round_id, created_at, trace_id, judged?, items, checks, fix_marks}]`
import { FINDING_KINDS, normalizeFindings } from "./judge-package.mjs";

/** `skill` 是非确定性的：一轮没再犯不算数，要连续两轮 `fixed` 才关（rubric §复验）。 */
const REQUIRED_FIXED_ROUNDS = (kind) => (kind === "skill" ? 2 : 1);
/** 这两类不进待复验清单：`model` 只计次，`unsure` 等的是人来核，不是等下一轮自己复验。 */
const NOT_RECHECKED = new Set(["model", "unsure"]);

/**
 * 修的人标了 `wont_fix` 的也不进清单：他已经说了这条不修，再让每一轮判官去复验，
 * 只会让「漏验」的数字随轮次单调上涨，把真正漏掉的那几条淹掉。
 * `needs_human`（要人协助）与 `claimed_fixed`（改了等复验）都还留在清单里——前者还没了结，
 * 后者恰恰**必须**复验：标记是声明，复验才是判决。
 */
const MARK_CLOSES = new Set(["wont_fix"]);

const roundsOf = (rounds) => (rounds ?? []).filter((r) => r && (r.items || r.checks));

/**
 * 走一遍历史，算出每个 key 的当前状态。
 * @returns {Map<string,{key:string,kind:string,open:boolean,streak:number,last_status:string,since:string,fix_mark:string|null}>}
 */
function replay(rounds) {
  const state = new Map();
  for (const r of roundsOf(rounds)) {
    const items = Array.isArray(r.items) ? r.items : normalizeFindings(r).items;
    const checks = Array.isArray(r.checks) ? r.checks : [];
    for (const it of items) {
      const key = String(it?.key ?? "");
      if (!key) continue;
      const kind = FINDING_KINDS.includes(it?.kind) ? it.kind : "tool";
      // 关了之后又被当新条目提出来 = 重新算没关（rubric：换个 key 把老缺口当新的提更不行）。
      // **修复标记要留着**：它跟的是这个缺口，不是某一轮——上一轮打的 claimed_fixed，
      // 这一轮重提时清掉的话，判官就不知道「有人说改过了，该特意走那条路去验」。
      const prev = state.get(key);
      state.set(key, { key, kind, open: true, streak: 0, last_status: "proposed", since: prev?.since ?? r.round, fix_mark: prev?.fix_mark ?? null });
    }
    for (const c of checks) {
      const key = String(c?.key ?? "");
      const cur = state.get(key);
      if (!key || !cur) continue;
      const kind = FINDING_KINDS.includes(c?.kind) ? c.kind : cur.kind;
      if (c.status === "fixed") {
        const streak = cur.streak + 1;
        state.set(key, { ...cur, kind, streak, last_status: "fixed", open: streak < REQUIRED_FIXED_ROUNDS(kind) });
      } else if (c.status === "still_open") {
        state.set(key, { ...cur, kind, streak: 0, last_status: "still_open", open: true });
      } else if (c.status === "not_exercised") {
        // 不算数：那一条维持原状（既不关，也不算又撞上）。**也不打断 skill 类的连胜**——
        // 「连续两轮 fixed」数的是两次**有效复验**，中间夹一轮没走到那条路不该把计数清零，
        // 否则一条走得少的路永远关不掉。
        state.set(key, { ...cur, kind, last_status: "not_exercised" });
      }
    }
    const marks = r.fix_marks && typeof r.fix_marks === "object" ? r.fix_marks : {};
    for (const [key, m] of Object.entries(marks)) {
      const cur = state.get(key);
      if (cur) state.set(key, { ...cur, fix_mark: m?.status ?? (String(m ?? "") || null) });
    }
  }
  return state;
}

/**
 * 还没关的条目 = 下一轮**必须逐条复验**的清单。判题会话开判前先拿它，判完对着它点名，
 * 比让判官自己从 `prior-judgments.json` 里推可靠。
 */
export function openFindings(rounds) {
  return [...replay(rounds).values()]
    .filter((s) => s.open && !NOT_RECHECKED.has(s.kind) && !MARK_CLOSES.has(s.fix_mark))
    .map(({ key, kind, last_status, since, fix_mark }) => ({ key, kind, last_status, since, fix_mark }));
}

/**
 * 这道题（或这一批）的判题质量账。`check_coverage` 算的是**最后一轮**：开判前该验几条、实际验了几条。
 */
export function qualityReport(rounds) {
  const list = roundsOf(rounds);
  const byKind = {};
  let itemsTotal = 0; let abstained = 0; let needsHuman = 0;
  let marked = 0; let wontFix = 0; let needsHumanMark = 0;
  const markByKey = new Map();
  for (const r of list) {
    const items = Array.isArray(r.items) ? r.items : normalizeFindings(r).items;
    for (const it of items) {
      itemsTotal += 1;
      const kind = FINDING_KINDS.includes(it?.kind) ? it.kind : "unknown";
      byKind[kind] = (byKind[kind] ?? 0) + 1;
      if (kind === "unsure") { abstained += 1; needsHuman += 1; }
    }
    for (const [key, m] of Object.entries(r.fix_marks && typeof r.fix_marks === "object" ? r.fix_marks : {})) {
      const st = m?.status ?? m;
      if (st) markByKey.set(key, st);   // 同一个 key 被标了好几轮，只算最后一次（见下）
    }
  }
  // 无效条目率的分母是**条目**，不是「轮次 × 条目」：一个 key 在三轮里都带着标记，
  // 按轮次数会把它算三次，把比率算歪。
  for (const st of markByKey.values()) {
    marked += 1;
    if (st === "wont_fix") wontFix += 1;
    if (st === "needs_human") needsHumanMark += 1;
  }

  const last = list[list.length - 1];
  const due = last ? openFindings(list.slice(0, -1)) : [];
  const checkedKeys = new Set((last?.checks ?? []).map((c) => String(c?.key ?? "")));
  const missed = due.filter((d) => !checkedKeys.has(d.key)).map((d) => d.key);

  return {
    rounds: list.length,
    items_total: itemsTotal,
    by_kind: byKind,
    // 弃判单列：它不是一条「挖到的缺陷」，动作也相反（去核，不是去修）
    abstention_rate: itemsTotal ? abstained / itemsTotal : 0,
    needs_human: needsHuman + needsHumanMark,
    // 无效条目率：分母只算**被修的人标过的**条目——没人标过的不能当成都有效
    marked,
    wont_fix: wontFix,
    wont_fix_rate: marked ? wontFix / marked : null,
    check_coverage: { due: due.length, checked: due.length - missed.length, missed },
    open_now: openFindings(list).length,
  };
}
