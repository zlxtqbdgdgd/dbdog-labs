// exp-client.mjs — llmobs runner 的 dbdog-server REST 客户端（eval 面 E2）。
// 鉴权两种，**优先用户面**（2026-09-11：飞轮要能给拿不到内部凭证的普通用户跑）：
//   - `DBDOG_API_KEY` → `DD-API-KEY` 头。控制台 /settings/api-keys 签发，与 hooks 上报 span 同一把；
//     **key 自带租户**（server 从 key hash 解析 org，`auth.go` 的 API key 分支不看 org 头），所以不发 x-dbdog-org。
//   - `DBDOG_INTERNAL_TOKEN` → `Authorization: Bearer` + `x-dbdog-org`。内部/CI 面，租户靠头指定。
// 两者都没有 = fail closed（各脚本开头调 `requireCredential()`，不再各写一份 env 检查）。
// 与 import-diagbench-dataset.mjs 同路。零依赖。
//
// 两个面，故意不统一（2026-08-27 切换计划步 3）：
//   - projects / datasets / records 走**新面** `/api/v2/llm-obs/v1/`（DD 镜像，JSON:API 信封）；
//   - experiments 的写入/读摘要仍走**旧面** `/api/v2/llmobs/`——新面没有 summary 那条路由，
//     切过去就是把功能删掉。等新面补上再动，别为了「前缀统一」提前搬。

const BASE = (process.env.DBDOG_BASE_URL || "http://127.0.0.1:8080").replace(/\/$/, "");
// `DBDOG_OBS_API_KEY` 是 hooks 装插件时写进 Claude Code settings.json 的那把——**同一把 key**。
// agent 在那个环境里跑脚本时它本来就在，认它等于用户少配一次；不认的话，
// 用户会拿着一把已经配好的 key，被要求再配一个只是名字不同的变量。
const API_KEY = process.env.DBDOG_API_KEY || process.env.DBDOG_OBS_API_KEY || "";
const TOKEN = process.env.DBDOG_INTERNAL_TOKEN || "";
const ORG = process.env.DBDOG_ORG || "default";

/**
 * 鉴权头的**唯一产地**。两种凭证不并发：有 API key 就走用户面，
 * 免得内部 token 在场时静默盖掉用户面、让「用 API key 到底通不通」永远验不出来。
 */
export function authHeaders({ internalOnly = false } = {}) {
  // internalOnly：这条路由在 server 端硬验内部 bearer（探针直查口是唯一一个），
  // 用户面那把 key 打过去只会 401。**不能让优先级决定它**——装了 hooks 的人环境里
  // 永远有 DBDOG_OBS_API_KEY，API key 一优先，这类口就再也用不上了。
  if (internalOnly) return TOKEN ? { authorization: `Bearer ${TOKEN}`, "x-dbdog-org": ORG } : {};
  if (API_KEY) return { "DD-API-KEY": API_KEY };
  if (TOKEN) return { authorization: `Bearer ${TOKEN}`, "x-dbdog-org": ORG };
  return {};
}

/** 有没有内部凭证（与「当前生效的是哪一种」是两回事）。 */
export function hasInternalToken() {
  return Boolean(TOKEN);
}

/** 当前生效的凭证种类：脚本据此打印自己在用哪一面，出错时一眼看出是不是拿错了 key。 */
export function credentialKind() {
  return API_KEY ? "api-key" : TOKEN ? "internal" : "none";
}

/**
 * fail closed 的凭证检查（取代各脚本各写一份 `if (!process.env.DBDOG_INTERNAL_TOKEN)`）。
 * 返回凭证种类，调用方可打印。
 */
export function requireCredential() {
  const kind = credentialKind();
  if (kind === "none") {
    console.error("✗ 需要凭证：DBDOG_API_KEY 或 DBDOG_OBS_API_KEY（控制台 /settings/api-keys 签发，装 hooks 时配的就是它）；内部面可用 DBDOG_INTERNAL_TOKEN");
    process.exit(1);
  }
  return kind;
}

/** 控制面新前缀（server ADR-0049 镜像 DD）。 */
export const CP = "/api/v2/llm-obs/v1";

export function baseUrl() {
  return BASE;
}

export async function call(method, p, body) {
  const res = await fetch(`${BASE}${p}`, {
    method,
    headers: {
      ...authHeaders(),
      ...(body ? { "content-type": "application/json" } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(30_000),
  });
  const text = await res.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch { /* 非 JSON 原样报 */ }
  if (!res.ok) {
    throw new Error(`HTTP ${res.status} ${method} ${p}: ${text.slice(0, 300)}`);
  }
  return json;
}

// ── JSON:API 信封 ───────────────────────────────────────────────────────────────
// 新面的元素是 `{id,type,attributes}`，集合是 `{data:[…],meta:{after}}`；
// 旧面回的是裸对象 + `{projects|datasets|records:[…], next_cursor}`。
// 下游（run-experiment / curate-record）按 `r.id / r.input / r.metadata` 读，
// 所以在这一层就压平回去，别让信封形状漏到每个调用点。

/** 元素 → `{id, ...attributes}`。 */
export function flatten(el) {
  if (!el) return null;
  return { id: el.id, ...(el.attributes ?? {}) };
}

/** JSON:API 请求体信封。records 那条的 type 也是 `datasets`（DD 实测，不是笔误）。 */
export function doc(type, attributes) {
  return { data: { type, attributes } };
}

/**
 * record 的 tags：**算出来**，不写死。
 * 新面的 create 请求 schema 里没有 tags（DD 就没有这个字段），GET 视图也不带它，
 * 所以我方把 tags 放进 `metadata.dbdog.tags` 存活（metadata 是用户任意 JSON，
 * 不算给镜像面加字段）。这里先认 wire——将来 wire 真带上 tags 就自动以 wire 为准，
 * 不必回来改这个函数。
 */
export function recordTags(rec) {
  if (Array.isArray(rec?.tags) && rec.tags.length) return rec.tags;
  const t = rec?.metadata?.dbdog?.tags;
  return Array.isArray(t) ? t : [];
}

/** 把 tags 折进 metadata（写路径的对偶，与 {@link recordTags} 成对改）。 */
export function withTags(metadata, tags) {
  if (!tags?.length) return metadata;
  return { ...(metadata ?? {}), dbdog: { ...(metadata?.dbdog ?? {}), tags } };
}

/** 翻到底的唯一表示是空串（不是 null、不是缺键）。 */
function hasMore(meta) {
  return Boolean(meta?.after);
}

// ── projects / datasets / records（新面）──────────────────────────────────────

/** 按名取 project；不存在回 null。 */
export async function findProject(name) {
  const page = await call("GET", `${CP}/projects?filter[name]=${encodeURIComponent(name)}`);
  return flatten(page?.data?.[0]);
}

/** 建 project。新面是 **get-or-create**：同名复得也回 200（旧面回 409），故无需 409 分支。 */
export async function createProject(name, description) {
  const out = await call("POST", `${CP}/projects`, doc("projects", { name, description }));
  return flatten(out?.data);
}

/** 按名取 dataset；不存在回 null。project 作用域路径没有字面 `projects` 段（DD 实测）。 */
export async function findDataset(projectID, name) {
  const page = await call("GET",
    `${CP}/${projectID}/datasets?filter[name]=${encodeURIComponent(name)}`);
  return flatten(page?.data?.[0]);
}

/** 建 dataset。同为 get-or-create；project 不存在回 404（我方 FK，ADR-0049 §6.3 登记的有意偏离）。 */
export async function createDataset(projectID, name, description, metadata) {
  const out = await call("POST", `${CP}/${projectID}/datasets`,
    doc("datasets", { name, description, ...(metadata === undefined ? {} : { metadata }) }));
  return flatten(out?.data);
}

/** 列 records（自动翻页；`page[cursor]` + `meta.after`，旧面是 `cursor` + `next_cursor`）。 */
export async function listRecords(projectID, datasetID, { limit = 100, all = true } = {}) {
  const out = [];
  let cursor = "";
  for (;;) {
    const page = await call("GET",
      `${CP}/${projectID}/datasets/${datasetID}/records?page[limit]=${limit}` +
      (cursor ? `&page[cursor]=${encodeURIComponent(cursor)}` : ""));
    out.push(...(page?.data ?? []).map(flatten));
    cursor = page?.meta?.after ?? "";
    if (!all || !hasMore(page?.meta)) break;
  }
  return out;
}

/** 追加 records。`tags` 折进 metadata；请求 type 是 `datasets`。 */
export async function addRecords(projectID, datasetID, records) {
  const payload = records.map((r) => ({
    input: r.input,
    expected_output: r.expected_output,
    metadata: withTags(r.metadata, r.tags),
  }));
  const out = await call("POST", `${CP}/${projectID}/datasets/${datasetID}/records`,
    doc("datasets", { records: payload }));
  return (out?.data ?? []).map(flatten);
}

/**
 * 批量更新 records（DD `PATCH …/records`，operationId UpdateLLMObsDatasetRecords；server 6aa2faed 起有）。
 * 每项 `{id, input?, expected_output?, metadata?}`：给了哪个键改哪个，metadata 整体替换；全批一个版本号 +1。
 * 请求 type 是 `datasets`（活体夹具纠正过，不是 spec 写的 records）；响应扁平 `{data:[…]}`。
 */
export async function updateRecords(projectID, datasetID, records) {
  const out = await call("PATCH", `${CP}/${projectID}/datasets/${datasetID}/records`,
    doc("datasets", { records }));
  return (out?.data ?? []).map(flatten);
}

/** 软删 records（收尾用；请求 type 同为 `datasets`）。 */
export async function deleteRecords(projectID, datasetID, recordIDs) {
  const out = await call("POST", `${CP}/${projectID}/datasets/${datasetID}/records/delete`,
    doc("datasets", { record_ids: recordIDs }));
  return (out?.data ?? []).map(flatten);
}

/** 软删 datasets。 */
export async function deleteDatasets(projectID, datasetIDs) {
  const out = await call("POST", `${CP}/${projectID}/datasets/delete`,
    doc("datasets", { dataset_ids: datasetIDs }));
  return (out?.data ?? []).map(flatten);
}

/** 软删 projects。 */
export async function deleteProjects(projectIDs) {
  return call("POST", `${CP}/projects/delete`, doc("projects", { project_ids: projectIDs }));
}

/** 按名解析 project → dataset → 全量 records（E1 面）。 */
export async function loadDataset({ projectName, datasetName }) {
  const project = await findProject(projectName);
  if (!project?.id) throw new Error(`project 不存在：${projectName}`);
  const dataset = await findDataset(project.id, datasetName);
  if (!dataset?.id) throw new Error(`dataset 不存在：${datasetName}（project ${projectName}）`);
  const records = await listRecords(project.id, dataset.id);
  // tags 在新面的 GET 视图里没有，统一补回来（来源见 recordTags），
  // 让下游 `r.tags` 的两处 `kind:` 选择保持能用。
  for (const r of records) r.tags = recordTags(r);
  return { project, dataset, records };
}

// ── experiments / spans（仍在旧面，见文件头）──────────────────────────────────

/** 单条 experiment event 摄入（ADR-0035 native events 形）。 */
export async function postExperimentEvent(experimentID, event) {
  return call("POST", `/api/v2/llmobs/experiments/${encodeURIComponent(experimentID)}/events`, { events: [event] });
}

/** 批量转发 hooks 落盘的 spans（Replacing 幂等，重发无害）。 */
/**
 * 本地 spans.jsonl 是 hook 的追加流：同一 span_id 会被重发（root 随 Stop 反复刷、子代理树后写赢），
 * server 的批量 ingest 拒绝「一批内同 span_id」（400 span_id must be unique within a trace），
 * 而 hook 自己分批上报天然不会撞——兜底转发前按 span_id 只留**最后一次**（与 hook 的后写赢同义）。
 * 2026-09-09 P0 冒烟实证：694 行里 329 个重复，整批被拒，本地留底。
 */
export function dedupSpans(spans) {
  const last = new Map();
  for (const sp of spans) {
    const id = sp?.span_id;
    if (typeof id !== "string" || !id) continue;
    last.delete(id);
    last.set(id, sp);
  }
  return [...last.values()];
}

/**
 * 兜底转发 spans。**走 hooks 同一条路**：`DBDOG_OBS_REPORT_URL`（dbdog-mcp 边缘口）+ `DBDOG_OBS_API_KEY`
 * 两个 env 齐备就发到边缘口（DD-API-KEY 鉴权），缺一才退回 server 直连（内部凭证）。
 *
 * 为什么不能一直直连 server：边缘代理转发时给 root span 盖 mcp 那一章（mcp_version / skills_digest /
 * tools_digest），server 是 ReplacingMergeTree 后写赢——hook 经边缘口发过的 root 若再被这里直连 server
 * 重发一遍，盖好的章就被没章的那份覆盖掉。同一条 trace 只许走一条路。
 */
export function spansSink(env = process.env) {
  const url = env.DBDOG_OBS_REPORT_URL?.trim();
  const key = env.DBDOG_OBS_API_KEY?.trim();
  if (url && key) return { kind: "edge", url, key };
  return { kind: "server", url: `${BASE}/api/v2/llmobs/spans` };
}

export async function postSpans(spans, { fetchImpl = fetch, sink = spansSink() } = {}) {
  for (let i = 0; i < spans.length; i += 200) {
    const batch = { spans: spans.slice(i, i + 200) };
    if (sink.kind === "server") {
      await call("POST", "/api/v2/llmobs/spans", batch);
      continue;
    }
    const res = await fetchImpl(sink.url, {
      method: "POST",
      headers: { "content-type": "application/json", "DD-API-KEY": sink.key },
      body: JSON.stringify(batch),
      signal: AbortSignal.timeout(30_000),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status} POST ${sink.url}: ${(await res.text()).slice(0, 300)}`);
  }
  return sink.kind;
}

export async function getExperimentSummary(experimentID) {
  return call("GET", `/api/v2/llmobs/experiments/${encodeURIComponent(experimentID)}/summary`);
}

// ── annotation 面（判题，PG 租户 schema）───────────────────────────────────────
// 前缀与控制面同为 `/api/v2/llm-obs/v1`，但**不是 JSON:API 信封**：请求/响应都是裸对象
// （`{queues:[…]}` / `{label_schemas:[…]}` / `{annotations:[…]}`）。别拿 doc()/flatten() 套。
// 存储口没接线时四条全部回 400「annotation queues are not enabled」——不是 404、不是空集。

/** 列判题队列（`project_id` 与 `queue_ids` 互斥，同时给回 400）。 */
export async function listAnnotationQueues({ projectID = "", queueIDs = [] } = {}) {
  const q = new URLSearchParams();
  if (projectID) q.set("project_id", projectID);
  if (queueIDs.length) q.set("queue_ids", queueIDs.join(","));
  const out = await call("GET", `${CP}/annotation-queues${q.toString() ? `?${q}` : ""}`);
  return out?.queues ?? [];
}

/** 建/复得队列。幂等键是 `(project_id, name)`，冲突只刷 updated_at。 */
export async function upsertAnnotationQueue({ name, projectID, queueID }) {
  return call("POST", `${CP}/annotation-queues`,
    { ...(queueID ? { queue_id: queueID } : {}), name, project_id: projectID });
}

export async function listAnnotationLabels(queueID) {
  const out = await call("GET", `${CP}/annotation-queues/${encodeURIComponent(queueID)}/labels`);
  return out?.label_schemas ?? [];
}

/**
 * 整表替换 label schema。**危险口**：server 侧是「DELETE 整队列标签 + 重插」，而
 * `llmobs_annotations.label_id` 对标签表是 ON DELETE CASCADE——**不带原 id 重发一次，
 * 会把该队列已有的全部 annotation 连带删光**。所以只在队列全新（没有 label）时调，
 * 已有 label 一律读回 id 复用（judge-package-export.mjs 就是这么做的）。
 */
export async function replaceAnnotationLabels(queueID, labelSchemas) {
  const out = await call("PUT", `${CP}/annotation-queues/${encodeURIComponent(queueID)}/labels`,
    { label_schemas: labelSchemas });
  return out?.label_schemas ?? [];
}

/** 排队（`content_id` = trace_id，`content_kind` = "trace"）。幂等：同 (queue,content) 覆盖 kind。 */
export async function addAnnotationInteractions(queueID, interactions) {
  const out = await call("POST", `${CP}/annotation-queues/${encodeURIComponent(queueID)}/interactions`,
    { interactions });
  return out?.annotated_interactions ?? [];
}

/** 写标注。幂等：`(interaction_id,label_id)` 覆盖，改判不留历史（设计 D5）。 */
export async function upsertAnnotations(annotations) {
  const out = await call("POST", `${CP}/annotations`, { annotations });
  return out?.annotations ?? [];
}

/** 按 content_id（= trace_id）反查已有批注。`annotations: []` = 已排队没人评，与「不在队列」不同档。 */
export async function findAnnotationsByContent(contentIDs, { limit = 200, offset = 0 } = {}) {
  const q = new URLSearchParams({ content_ids: contentIDs.join(","), limit: String(limit), offset: String(offset) });
  const out = await call("GET", `${CP}/annotations?${q}`);
  return out?.annotated_interactions ?? [];
}

/**
 * 一批 trace 的批注全取（分块 + 翻到底），回 `Map<content_id, interaction[]>`。
 *
 * **为什么要分块**（取证 server `postgres/llmobs_annotation_store.go` 的
 * `FindAnnotationsByContentIDs`）：`LIMIT/OFFSET` 加在 `interaction LEFT JOIN annotation`
 * 的**扁平行**上，一条 trace 判满 7 个 label 就是 7 行；而回包 `total_count` 数的是
 * **interaction 条数**。所以「按 limit 数 trace」会静默漏判——一次问 20 条 content_id
 * （20×7=140 < 上限 200），才保证一页装得下整块。`truncated` 为真再往后翻。
 */
export async function findAllAnnotationsByContent(contentIDs, { chunk = 20, limit = 200 } = {}) {
  const byContent = new Map();
  for (let i = 0; i < contentIDs.length; i += chunk) {
    const slice = contentIDs.slice(i, i + chunk);
    for (let offset = 0; ; offset += limit) {
      const q = new URLSearchParams({ content_ids: slice.join(","), limit: String(limit), offset: String(offset) });
      const out = await call("GET", `${CP}/annotations?${q}`);
      const items = out?.annotated_interactions ?? [];
      for (const it of items) {
        const key = String(it.content_id ?? "");
        if (!byContent.has(key)) byContent.set(key, []);
        byContent.get(key).push(it);
      }
      if (!out?.truncated || items.length === 0) break;
    }
  }
  return byContent;
}

// ── spans 检索（旧面读口，dbdog 扩展）────────────────────────────────────────

/**
 * 一页 span 检索。请求体逐字照 server `internal/api/llmobs.go` 的 `llmobsSearchRequest`：
 * `trace_id / span_id / kind / name / session_id / user_id / ml_app / tags / root_only /
 * from / to / sort_asc / cursor / limit`。from/to 只吃 **RFC3339 绝对时间**（相对时间在调用方解析）；
 * 都不给时 server 兜底近 24h。`limit` 上限 5000（`spansSearchMaxLimit`），越界它自己夹到 5000。
 */
export async function searchSpans(query = {}) {
  return call("POST", "/api/v2/llmobs/spans/search", query);
}

/**
 * 翻到底的 span 检索（keyset 游标）。
 * 取证 `clickhouse/spans_store.go`：多取一条判有没有下一页，**有下一页才回 `next_cursor`**
 * ⇒ `next_cursor` 空串/缺键 = 到底了，不是「游标失效」。游标载荷是 `(ts, span_id)`，
 * 与排序键同构，翻页期间新写入的 span 不会把已翻过的挤重复。
 */
export async function searchAllSpans(query = {}, { limit = 1000, onPage } = {}) {
  const out = [];
  let cursor = "";
  for (;;) {
    const page = await searchSpans({ ...query, limit, ...(cursor ? { cursor } : {}) });
    const spans = page?.spans ?? [];
    out.push(...spans);
    if (onPage) onPage(spans, out.length);
    cursor = page?.next_cursor ?? "";
    if (!cursor || spans.length === 0) break;
  }
  return out;
}

// ── trace / experiment events（旧面读口）──────────────────────────────────────

/** 整条 trace（`{status,trace_id,spans:[…],tree:[…]}`；无 span 时 status=not_found）。 */
export async function getTrace(traceID) {
  return call("GET", `/api/v2/llmobs/trace/${encodeURIComponent(traceID)}`);
}

/** 一页 experiment events 摘要（server 侧 limit 上限 20，靠 offset 翻）。 */
export async function searchExperimentEvents(experimentID, { limit = 20, offset = 0 } = {}) {
  return call("POST", `/api/v2/llmobs/experiments/${encodeURIComponent(experimentID)}/events/search`, { limit, offset });
}

/** 翻到底的全部 event 摘要（含 trace_id / dataset_record_id / dimensions）。 */
export async function listAllExperimentEvents(experimentID) {
  const out = [];
  for (let offset = 0; ; offset += 20) {
    const page = await searchExperimentEvents(experimentID, { limit: 20, offset });
    out.push(...(page?.events ?? []));
    if (out.length >= (page?.total ?? out.length) || (page?.events ?? []).length === 0) break;
  }
  return out;
}

/** 单条 event 全文（比摘要多 input / output / expected_output）。 */
export async function getExperimentEvent(experimentID, eventID) {
  return call("GET",
    `/api/v2/llmobs/experiments/${encodeURIComponent(experimentID)}/events/${encodeURIComponent(eventID)}`);
}

// ── experiments 控制面（新面；run 的建行口 + run metadata 的写口）──────────────

/** 控制面 id 是 PG uuid；runner P3 之前用的自由串（`diagbench-20260909-1608`）不是。 */
export function isUUID(v) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(String(v ?? "").trim());
}

/**
 * 列控制面 experiments。四个过滤都实测有（server `llmobs_control_plane.go:1284-1334` →
 * store `:830-851`）：`filter[id]`（多值全取）/ `filter[name]`（**run 名**）/
 * `filter[experiment]`（**逻辑名**，一个逻辑名下多条 run）/ `filter[project_id]`。
 * 排序恒 `created_at DESC, id DESC`（store `:868`）⇒ **第一条就是最新那条**，不必自己排。
 */
export async function listCPExperiments({ projectID = "", name = "", experiment = "", ids = [] } = {}) {
  const q = new URLSearchParams();
  if (projectID) q.set("filter[project_id]", projectID);
  if (name) q.set("filter[name]", name);
  if (experiment) q.set("filter[experiment]", experiment);
  if (ids.length) q.set("filter[id]", ids.join(","));
  const page = await call("GET", `${CP}/experiments${q.toString() ? `?${q}` : ""}`);
  return (page?.data ?? []).map(flatten);
}

/**
 * 把人写的一个串（`--experiment` / `--parent` 的取值）解析成控制面的那一行。
 * uuid → `filter[id]` 一次定位；否则先按 run 名（`filter[name]`，建行时唯一），
 * 再退按逻辑名（`filter[experiment]`，同名多条取最新一条 = 列表第一条）。
 *
 * **解析不到回 null，由调用方 fail closed**：拼错的 parent 比没有 parent 更糟——对比页
 * 会拿这条 run 去跟一条不相干的 run 比；而 `parent_experiment_id` 列上没有外键
 * （pg/0020 建表段），server 不会替我们挡下瞎写的 uuid，所以 uuid 也要落地核一次。
 */
export async function resolveExperimentRef(ref, { projectID = "" } = {}) {
  const v = String(ref ?? "").trim();
  if (!v) return null;
  if (isUUID(v)) return (await listCPExperiments({ ids: [v] }))[0] ?? null;
  const byRunName = await listCPExperiments({ projectID, name: v });
  if (byRunName.length) return byRunName[0];
  return (await listCPExperiments({ projectID, experiment: v }))[0] ?? null;
}

/**
 * 开跑前先建一条 run（控制面行），回扁平后的行——**`row.id` 就是 events 的 `experiment_id`**。
 *
 * 为什么 events 可以直接用这个 uuid：建行那条 SQL 里 `events_key = id::text`
 * （store 的 GetOrCreateLlmobsCPExperiment），而旧面 events 口按 events_key 认 run
 * ⇒ 事件形状一个字节都不用改，跑完那一刻控制面就已经有这条 run（judge_summary 有了落点，
 * 不再等启动期 Reconcile 回填）。
 *
 * `ensure_unique` 显式给 true（也是 server 默认）：**run 每次都是新 run**，同逻辑名不复用旧行——
 * server 给 **run 名**加 `-<epoch ms>` 后缀、**逻辑名**（`experiment` 列）留 `name` 原样。
 * `config` 不发：版本章由 trace 推导（D6「谁经手谁盖，不许手填」）。
 */
export async function createExperimentRun({
  projectID, datasetID, datasetVersion = null, name, parentExperimentID = "", metadata = null,
}) {
  const out = await call("POST", `${CP}/experiments`, doc("experiments", {
    project_id: projectID,
    dataset_id: datasetID,
    name,
    ensure_unique: true,
    ...(Number.isInteger(datasetVersion) ? { dataset_version: datasetVersion } : {}),
    ...(parentExperimentID ? { parent_experiment_id: parentExperimentID } : {}),
    ...(metadata && Object.keys(metadata).length ? { metadata } : {}),
  }));
  const row = flatten(out?.data);
  if (!row?.id) throw new Error(`建 run 失败：POST ${CP}/experiments 没回 id`);
  return row;
}

/** PATCH experiment（metadata 可写——`judge_summary` 就挂这）。id 是控制面 UUID，不是 runner 的自由串。 */
export async function patchCPExperiment(experimentID, attributes) {
  return call("PATCH", `${CP}/experiments/${encodeURIComponent(experimentID)}`, doc("experiments", attributes));
}

/**
 * 带状态码的调用（`call` 一律抛错，探一条路由在不在得看状态码）。
 * 用于「这条写口 server 有没有」这类判定——404/405 是缺口，不是故障。
 */
export async function callStatus(method, p, body, opts = {}) {
  const res = await fetch(`${BASE}${p}`, {
    method,
    headers: {
      ...authHeaders(opts),
      ...(body ? { "content-type": "application/json" } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(30_000),
  });
  const text = await res.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch { /* 非 JSON 原样交回 */ }
  return { ok: res.ok, status: res.status, json, text };
}
