// case-diag-client.mjs —— 用例诊断表的客户端（server 蓝图 pg/0025 · ADR-0049 偏离 #21）。
//
// **一行 = 一次复现**，不是一条用例。同一道题复现 N 次就有 N 行，各自诊断、各自判题。
// 行由复现回执创建（另一个系统复现完把窗口推给 server），五态按顺序流转：
//
//   pending_diagnosis → diagnosing → pending_judgement → judging → judged
//
// judging 是 2026-09-11 owner 看页面时补的（蓝图 0026）：判题与诊断同构，也是按周期醒的
// loop、单条判题也会跑过一轮的间隔，没有这一档就分不出「还没轮到」和「正在判」。
//
// ## 为什么两条 loop 要改成抢这张表，而不是继续「每轮现算差集」
//
// 差集算的是「有复现、没 trace」。**它没有在途这一档**：loop 每 30 分钟一轮而单条诊断超时
// 40 分钟，两轮必然重叠——第一轮还在跑，第二轮去算差集，那条还没有 trace，于是被当成待跑
// 又发一遍。同一次复现被诊断两遍，烧两份 agent 预算，还会在判题队列里留下两条互相矛盾的轨迹。
// 2026-09-11 查过：整条链路上没有任何锁，这个重入不是理论上的。
//
// 抢占把「在途」变成库里的一个态，且抢的动作本身是原子的（server 那边是单条带
// FOR UPDATE SKIP LOCKED 的 UPDATE）。两轮同时打进来，后到的那轮拿到的是下一条或者 204。
// 鉴权头复用 exp-client 那一份（DD-API-KEY 优先、内部 token 兜底）——
// 自己再拼一份就是第二个真相源，key 的取法一改就会漏掉这里（军规 3）。
import { baseUrl, authHeaders } from "./exp-client.mjs";

/**
 * 跑这条 loop 的**人**是谁（owner 2026-09-11：「这个环境变量在跑 loop 的时候要求用户给出，
 * 自己的身份是谁，比如我的就是 qinqiang」）。落进诊断表的 status_changed_by，
 * 页面「状态」列底下那行显的就是它。
 *
 * **缺了就拒跑，不给默认值**。能想到的三种默认值都答错了问题：
 *   · loop 实例名 / 机器名 → 那是 claimed_by 已经在记的东西（哪条 loop 占着租约）；
 *   · $USER → 机器上的账户名，跑在共用机器上时人人都是 dbdog；
 *   · 空串 → 页面上显成「—」，与 0026 之前的老行混在一起分不出来。
 * 状态是会被人拿去问「这步谁推的」的东西，宁可当场报错，也不要一个看着像答案的假答案。
 */
export function operator() {
  const v = (process.env.DBDOG_OPERATOR || "").trim();
  if (!v) {
    throw new Error(
      "缺 DBDOG_OPERATOR：跑 loop 要报上自己是谁（如 DBDOG_OPERATOR=qinqiang）。\n" +
      "  它落进诊断表的 status_changed_by，控制台用例表「状态」列显的就是这个串——\n" +
      "  没有它，页面上那一步是谁推的就再也查不出来了。",
    );
  }
  return v;
}

/** 五态，与 server 的 domain 常量同一份口径（值是线缆原文）。 */
export const DIAG_PENDING = "pending_diagnosis";
export const DIAG_DIAGNOSING = "diagnosing";
export const DIAG_PENDING_JUDGEMENT = "pending_judgement";
export const DIAG_JUDGING = "judging";
export const DIAG_JUDGED = "judged";

const path = (p) => `${baseUrl().replace(/\/+$/, "")}/api/v1/llm-obs/case-diagnoses${p}`;

async function call(url, init) {
  const res = await fetch(url, {
    ...init,
    headers: { ...authHeaders(), "content-type": "application/json", ...(init?.headers ?? {}) },
    signal: AbortSignal.timeout(30_000),
  });
  // 204 = 没活干。它是**正常态**不是错误：loop 每 30 分钟醒一次，绝大多数轮都是空的。
  if (res.status === 204) return null;
  const text = await res.text();
  if (!res.ok) {
    const err = new Error(`${init?.method ?? "GET"} ${url} → HTTP ${res.status}: ${text.slice(0, 300)}`);
    err.status = res.status;
    throw err;
  }
  return text ? JSON.parse(text) : null;
}

/**
 * 抢一条待诊断的复现，原子改成诊断中并占住租约。没有可抢的回 null。
 *
 * `staleAfterSec` 是**租约时长**：claimed_at 早于「现在减去它」的 diagnosing 行一并算作候选。
 * 由调用方给而不是服务端猜——只有调用方知道自己的诊断超时配了多少。给小了会把正在跑的那条
 * 抢走（两个进程同时诊断同一条），给大了卡住的行要等更久才被捞回来，所以按
 * **诊断超时 × 2** 取，留一倍余量给收尾与上报。
 */
export async function claimDiagnosis({ claimedBy, staleAfterSec, from, to }) {
  // claimed_by 记**哪条 loop** 占着租约（卡住时去哪台机器看），by 记**谁在跑**（出了事问谁）。
  const body = { claimed_by: claimedBy, by: operator() };
  if (staleAfterSec > 0) body.stale_after_sec = staleAfterSec;
  // from/to 留空 = 诊断那一档（pending_diagnosis → diagnosing）。判题那条 loop 传
  // pending_judgement → judging 走同一条抢占；租约回收捞的也是 to 态，两边对称。
  if (from) body.from = from;
  if (to) body.to = to;
  const out = await call(path("/claim"), { method: "POST", body: JSON.stringify(body) });
  return out?.data ?? null;
}

/**
 * 推进一条的状态。`from` 是**断言**不是摆设：只有当前正处于 from 才改得动，
 * 否则 server 回 409、这里回 null。
 *
 * 没有这个断言，一条被租约回收后重新诊断的行，会被上一个已经死掉的进程改成 pending_judgement
 * ——一次没跑完的诊断就这样被当成跑完了。所以**吞掉 409 不算错**，它正是断言在生效：
 * 本轮放弃这一条就好，下轮重抢。
 *
 * 经手人（status_changed_by）由 DBDOG_OPERATOR 给出，不用调用方传——它是**人**，
 * 整条 loop 从头到尾同一个值，让每个调用点各传一次只会漏掉某一处。server 侧必填。
 */
export async function advanceDiagnosis({ id, from, to, traceId }) {
  const body = { from, to, by: operator() };
  if (traceId) body.trace_id = traceId;
  try {
    const out = await call(path(`/${encodeURIComponent(id)}/advance`), { method: "POST", body: JSON.stringify(body) });
    return out?.data ?? null;
  } catch (e) {
    if (e.status === 409) return null;
    throw e;
  }
}

/** 列诊断行（看积压用）。statuses 为空 = 不筛。 */
export async function listDiagnoses({ statuses, recordIds, limit } = {}) {
  const q = new URLSearchParams();
  if (statuses?.length) q.set("status", statuses.join(","));
  if (recordIds?.length) q.set("record_id", recordIds.join(","));
  if (limit) q.set("limit", String(limit));
  const qs = q.toString();
  const out = await call(path(qs ? `?${qs}` : ""));
  return out?.data ?? [];
}

/**
 * 连着抢，最多 max 条，直到没得抢为止。
 *
 * 一轮抢多条再一起跑，是为了保住「一轮 = 一个 experiment」这条既有口径（重测挂 --parent
 * 才有对照物）。代价是进程被杀时有 max 条卡在 diagnosing——那正是租约要兜的事。
 */
export async function claimBatch({ claimedBy, staleAfterSec, max }) {
  const out = [];
  for (let i = 0; i < max; i++) {
    const row = await claimDiagnosis({ claimedBy, staleAfterSec });
    if (!row) break;
    out.push(row);
  }
  return out;
}
