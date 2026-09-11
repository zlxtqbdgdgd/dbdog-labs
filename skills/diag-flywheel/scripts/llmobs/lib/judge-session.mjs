// judge-session.mjs — 判题会话怎么起。
//
// 三件事，每件都是踩出来的：
//
// ① **必须挂 MCP**。判题要回答「模型没想到查 X」还是「查了但 dbdog 没采」，就得能自己去查
//    （飞轮 D2）。三条取证路：反向证据链（用例级资产）/ 探针结果（运行级资产）/ 现取证据。
//    owner 2026-09-10 定：在线判题用现取，不必要求反向链——那反过来要求会话连得上 dbdog。
//    2026-09-10 实测：判题会话没挂 MCP，而用例集也没有反向链、没有探针结果，**三条全断**，
//    「要修 dbdog」那一项根本判不出来。所以没给 MCP 配置就直接停，不许静默跑出假结论。
//
// ② **不锁 `--setting-sources project`**。锁成 project 会把用户级配置一并挡在外面，
//    连带用户自己配的 MCP server 也没了——这次断的就是这一处。
//
// ③ **禁掉所有钩子**。判题会话自己不该产 trace，不禁的话它会被采成 span，污染诊断面
//    （下一轮 loop-pending 会把它当成一次新诊断）。

/**
 * @param {{ mcpConfigPath?: string, model?: string, cwd?: string, timeoutMs?: number }} o
 * @returns {{ mcpConfigPath: string, model?: string, cwd?: string, captureTools: boolean,
 *            extraArgs: string[], timeoutMs?: number }}
 * @throws 没有 MCP 配置——见 ①
 */
export function judgeSessionArgs({ mcpConfigPath, model, cwd, timeoutMs } = {}) {
  if (!mcpConfigPath) {
    throw new Error(
      "判题会话缺 MCP 配置：判题要能按诊断的时间窗现取证据，否则「要修 dbdog」判不出来（飞轮 D2）。" +
      "设 DBDOG_MCP_URL + DBDOG_MCP_BEARER 后重试。",
    );
  }
  return {
    mcpConfigPath,
    ...(model ? { model } : {}),
    ...(cwd ? { cwd } : {}),
    captureTools: false,
    extraArgs: ["--settings", JSON.stringify({ disableAllHooks: true }), "--disable-slash-commands"],
    ...(timeoutMs ? { timeoutMs } : {}),
  };
}

/**
 * 判题会话该连的 MCP 地址：在诊断侧那份的基础上**补上 `llmobs` toolset**。
 *
 * 判题 skill 的「取数判题」明写要用 `get_llmobs_trace` / `search_llmobs_spans` /
 * `get_llmobs_dataset_records` / `get_llmobs_experiment_event` /
 * `get_llmobs_annotations_by_content_ids` —— 这些都在 `llmobs` toolset 下。
 * 而诊断侧的地址不带它（诊断不需要看别人的轨迹），直接复用就等于判题连不上那些工具：
 * 挂了 MCP 却调不了该调的，比不挂更糟——它会以为自己取过了。
 *
 * 其余查询参数原样保留：`databases` 决定引擎判据，丢了就串引擎。
 */
export function judgeMcpUrl(raw) {
  const v = String(raw ?? "").trim();
  if (!v) return v;
  let u;
  try { u = new URL(v); } catch { return v; }   // 不是 URL 就原样返回，不去猜
  const ts = (u.searchParams.get("toolsets") ?? "").split(",").map((x) => x.trim()).filter(Boolean);
  if (!ts.includes("llmobs")) {
    ts.push("llmobs");
    u.searchParams.set("toolsets", ts.join(","));
  }
  return u.toString();
}
