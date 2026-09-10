// DD 托管 MCP 的鉴权头：**唯一来源**。
//
// 起因（2026-08-28）：`sync-tools` / `sync-instructions` / `sync-skills` 三份逐字相同的
// 15 行凭证构造 + `probe-dd-find_instances` 与 `e2e-agent` 两份变体，共 5 处各写各的头名。
// 2026-08-28 实测：DD 侧只认 **`DD-API-KEY` / `DD-APPLICATION-KEY`（横线）**，下划线形一律
// `401 {"errors":["Unauthorized"]}` —— 三条 sync 通道（我们唯一的上游漂移探测器）当场全废。
// 它们失败得很响（rc=2 + 报错），只是没人跑；**注意别把这说成「DD 今天改了头名」**——
// 已实证的只有「此刻下划线不通、横线通」，下划线是否曾经可用没有证据。
// 同一事实五份副本，改一处忘四处（家族军规 3）；`scripts/api/` 下打 REST 面的几支
// 本来就用横线、属另一套契约，不并进来。
//
// 实证（同一份凭证、同一进程内对照）：
//   下划线 DD_API_KEY/DD_APPLICATION_KEY   → POST /v1/mcp 401 Unauthorized
//   横线   DD-API-KEY/DD-APPLICATION-KEY   → tools/list 200，117 个工具
//
// 头名**不许再在别处出现**：`scripts/lib/dd-mcp-auth.test.mjs` 扫全 scripts/ 树，
// 见到第二处自造就红。

/** 缺凭证时的统一报错文案（三处 sync 此前各写一份，措辞还不一样）。 */
export const MISSING_CREDENTIALS =
  "missing credentials: export DD_API_KEY + DD_APPLICATION_KEY (or DD_APP_KEY), e.g.\n" +
  "  source ~/.datadog/dbdog-mcp.env\n" +
  "or export DD_MCP_BEARER=<oauth token>.";

/**
 * 从环境算出 DD 托管 MCP 的请求头。
 * @param {{requireCredentials?: boolean}} [opts] requireCredentials=false 时缺凭证返回空头（e2e 侧沿用旧行为：交给下游报错）
 * @returns {Record<string,string>}
 */
export function ddMcpHeaders(opts = {}) {
  const { requireCredentials = true } = opts;
  const bearer = process.env.DD_MCP_BEARER;
  if (bearer) return { Authorization: `Bearer ${bearer}` };
  const apiKey = process.env.DD_API_KEY;
  const appKey = process.env.DD_APPLICATION_KEY || process.env.DD_APP_KEY;
  if (!apiKey || !appKey) {
    if (requireCredentials) throw new Error(MISSING_CREDENTIALS);
    return { "DD-API-KEY": apiKey || "", "DD-APPLICATION-KEY": appKey || "" };
  }
  return { "DD-API-KEY": apiKey, "DD-APPLICATION-KEY": appKey };
}
