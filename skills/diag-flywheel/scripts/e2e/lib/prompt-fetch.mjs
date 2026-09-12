// prompt-fetch.mjs — 注入平台 HTTP（Basic auth + 批量状态探测）。
const DEFAULT_BASE = "http://epyc-256c.e6.luyouxia.net:23234";

export function promptBaseUrl() {
  return (process.env.E2E_PROMPT_BASE_URL || DEFAULT_BASE).replace(/\/$/, "");
}

export function promptAuthHeaders() {
  const user = process.env.E2E_PROMPT_USER || "";
  const pass = process.env.E2E_PROMPT_PASS || "";
  if (!user) return null;
  return {
    Accept: "application/json",
    Authorization: `Basic ${Buffer.from(`${user}:${pass}`).toString("base64")}`,
  };
}

export function requireInstance(explicit) {
  const id = String(explicit || process.env.E2E_INSTANCE || "").trim();
  if (!id) {
    throw new Error("需指定实例：--instance <id> 或环境 E2E_INSTANCE（如 pg-primary / gauss-1）");
  }
  return id;
}

export async function benchGet(path, headers = promptAuthHeaders()) {
  if (!headers) throw new Error("需设置 E2E_PROMPT_USER / E2E_PROMPT_PASS");
  const url = `${promptBaseUrl()}${path.startsWith("/") ? path : `/${path}`}`;
  const res = await fetch(url, { headers });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    const err = new Error(`HTTP ${res.status} ${url}${body ? `: ${body.slice(0, 200)}` : ""}`);
    err.status = res.status;
    throw err;
  }
  return res.json();
}

/** @returns status object for one instance (flattened). */
export async function scenarioStatus(headers, instance) {
  const id = requireInstance(instance);
  const raw = await benchGet(`/api/scenario/status?instance=${encodeURIComponent(id)}`, headers);
  // New API may wrap; old flat status also ok.
  if (raw?.byInstance && raw.byInstance[id]) return raw.byInstance[id];
  return raw;
}

export function formatRunningStatus(st) {
  if (!st?.running) return null;
  if (st.batchTotal) {
    return `批量注入进行中 ${st.batchIndex ?? "?"}/${st.batchTotal}（当前 ${st.scenario ?? "—"}，队列 ${st.queued ?? "?"}）`;
  }
  return `场景运行中（${st.scenario ?? "—"}）`;
}

/** @returns {{ nl: Record<string,string>, instance: string, injectionRunning: boolean, ... }} */
export async function fetchE2eNl({ wait = false, pollMs = 30_000, headers, instance } = {}) {
  const id = requireInstance(instance);
  const h = headers ?? promptAuthHeaders();
  let st = null;
  if (wait) {
    for (;;) {
      st = await scenarioStatus(h, id);
      if (!st?.running) break;
      console.log(`  等待注入结束… ${formatRunningStatus(st)}`);
      await new Promise((r) => setTimeout(r, pollMs));
    }
  } else {
    try { st = await scenarioStatus(h, id); } catch (e) {
      if (!h || e.status === 401 || e.status === 403) throw e;
    }
  }
  const nl = await benchGet(`/api/diagbench/e2e-nl?instance=${encodeURIComponent(id)}`, h);
  if (!nl || typeof nl !== "object" || !Object.keys(nl).length) {
    throw new Error(`暂无实例 ${id} 的已注入场景现网用例（先在控制台对该实例跑批量注入）`);
  }
  return {
    nl,
    instance: id,
    injectionRunning: !!st?.running,
    batchIndex: st?.batchIndex,
    batchTotal: st?.batchTotal,
    scenario: st?.scenario,
    queued: st?.queued,
  };
}
