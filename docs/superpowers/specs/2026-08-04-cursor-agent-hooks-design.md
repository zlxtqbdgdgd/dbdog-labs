# Cursor Agent Observability Hooks — Design

Date: 2026-08-04  
Status: approved for v1 implementation  
Location: `dbdog-labs/cursor-agent-hooks/`

## Goal

Port the Claude Code Agent Observability kit (`claude-code-hooks/`) to **local Cursor CLI Agent**, so a turn starting with `诊断:` / `diag:` produces a full LLM Obs trace tree with:

- root agent span (question + final answer)
- llm spans (assistant text + thoughts)
- **complete tool call chain**: each dbdog MCP call has **name / intent / input / output** (failures included)
- subagent turns share the same `trace_id` and emit tool/llm spans under the same tree

## Non-goals (v1)

- Cloud Agents
- Marketplace plugin install for Cursor (CLI does not reliably run plugin hooks; file-based install only)
- Reusing Claude transcript JSONL synthesis as-is
- Parity of token usage fields (Cursor hooks usually omit usage → leave null)

## Architecture

Same pipeline as Claude: **mint → propagate → synthesize**.

| Role | Cursor hook | Script |
|------|-------------|--------|
| Mint | `beforeSubmitPrompt` | `before-submit-prompt.mjs` |
| Propagate | `preToolUse` (matcher `^MCP:`) | `pre-tool-use.mjs` |
| Tool synthesize | `afterMCPExecution` + `postToolUseFailure` | `after-mcp-execution.mjs`, `post-tool-use-failure.mjs` |
| LLM synthesize | `afterAgentResponse`, `afterAgentThought` | `after-agent-response.mjs`, `after-agent-thought.mjs` |
| Root + flush | `stop` | `stop.mjs` |
| Subagent link | `subagentStart` | `subagent-start.mjs` |
| Subagent flush | `subagentStop` | `subagent-stop.mjs` |

Session key: `conversation_id` (fallback `session_id`).  
State/spans dir: `~/.cursor/dbdog-obs/` (override via `DBDOG_OBS_DIR` / `DBDOG_OBS_SPANS`).  
Report: same as Claude — `DBDOG_OBS_REPORT_URL` + `DBDOG_OBS_API_KEY`.

### Trigger gate

Identical to Claude (`DBDOG_OBS_MODE`):

- `triggered` (default): prompt starts with `诊断:` / full-width `诊断：` / `diag:`
- `always` / `off`
- Non-trigger turns set `active: false` so tools never attach to the previous trace

### Tool naming

Cursor `preToolUse` tool names use `MCP:<tool_name>` (not Claude `mcp__server__tool`).  
Scripts accept both shapes; filter dbdog by `/dbdog/i` in the tool name (and optional server hint). Strip `telemetry` from recorded input; promote `telemetry.intent` to span `intent`.

### Subagents

On `subagentStart`, if the parent conversation has an active trace, clone state onto `subagent_id` (and current `conversation_id` if different) with `sidechain: "1"`. Subagent MCP/llm hooks then resolve the same `trace_id` / `root_span_id`.  
`subagentStop` flushes pending report batch; does **not** emit/replace the root agent span (only mainline `stop` does).

### Discipline

Hooks never break the session: catch errors, stderr only, exit 0. Fail-open.

## Acceptance

1. Install file hooks → new CLI agent session  
2. `诊断: …` that calls dbdog MCP tools (including via Task/subagent)  
3. Console LLM Obs shows one tree; each tool span has intent/input/output  
4. Without report env, `~/.cursor/dbdog-obs/spans.jsonl` still has the full local tree  

## Open risks

- Exact `MCP:` string for multi-server setups may include or omit server — scripts filter loosely and tests cover both `MCP:get_dbdog_*` and bare tool names on `afterMCPExecution`
- If `afterMCPExecution` does not fire for some CLI builds, `postToolUseFailure` alone is insufficient for success path — document fallback to widen matcher / check Hooks debug output
