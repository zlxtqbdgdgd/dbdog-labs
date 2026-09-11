// case-diag-client.mjs —— 用例诊断表的客户端（server 蓝图 pg/0025 · ADR-0049 偏离 #21）。
//
// **一行 = 一次复现**，不是一条用例。同一道题复现 N 次就有 N 行，各自诊断、各自判题。
// 行由复现回执创建（另一个系统复现完把窗口推给 server），四态按顺序流转：
//
//   pending_diagnosis → diagnosing → pending_judgement → judged
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

/** 四态，与 server 的 domain 常量同一份口径（值是线缆原文）。 */
export const DIAG_PENDING = "pending_diagnosis";
export const DIAG_DIAGNOSING = "diagnosing";
export const DIAG_PENDING_JUDGEMENT = "pending_judgement";
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
export async function claimDiagnosis({ claimedBy, staleAfterSec }) {
  const body = { claimed_by: claimedBy };
  if (staleAfterSec > 0) body.stale_after_sec = staleAfterSec;
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
 */
export async function advanceDiagnosis({ id, from, to, traceId }) {
  const body = { from, to };
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
