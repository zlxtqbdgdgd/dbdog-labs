// agent-kind.mjs — headless agent CLI：claude | codex | cursor（E2E_AGENT_KIND / E2E_AGENT_BIN）。
import path from "node:path";

export const AGENT_KINDS = ["claude", "codex", "cursor"];

/** @returns {"claude"|"codex"|"cursor"} */
export function resolveAgentKind() {
  const kind = String(process.env.E2E_AGENT_KIND || "").toLowerCase();
  if (kind === "codex" || kind === "claude" || kind === "cursor") return kind;
  const bin = String(process.env.E2E_AGENT_BIN || "claude");
  const base = path.basename(bin);
  if (/codex/i.test(base)) return "codex";
  // Cursor Agent CLI binary is commonly `agent` (not `cursor`).
  if (/^(agent|cursor-agent)$/i.test(base) || /cursor/i.test(base)) return "cursor";
  return "claude";
}

export function agentBin() {
  if (process.env.E2E_AGENT_BIN) return process.env.E2E_AGENT_BIN;
  const kind = resolveAgentKind();
  if (kind === "cursor") return "agent";
  return kind;
}

/** Codex / Cursor 读项目配置的工作目录。 */
export function agentCwd() {
  return process.env.E2E_AGENT_CWD || process.cwd();
}
