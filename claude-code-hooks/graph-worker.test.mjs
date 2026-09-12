// graph-worker 的预算用例（2026-09-12）：**模型不回，图照出**。
//
// 代码证据那一步要给每条回参各发一次模型调用。原来是串行 await、单条 30s 超时、整张图等它
// 跑完才落盘——端点一挂，连不需要模型的工具边都一起看不见。这里用一个「永不应答」的假端点
// 钉住：整件事必须在预算内收手，图与工具边照样落盘。
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { describe, expect, it } from "vitest";

/** 一条带真实形状回参的子代理派单（形状取自 trace 11d77280 的 a1c5430100）。 */
const RETURN_WITH_REFS = [
  "Verdict: **refuted**.",
  "",
  "**Refuting mechanism**",
  "- `src/gausskernel/optimizer/util/orclauses.cpp:71` `extract_restriction_or_clauses()`",
  "- 默认关：`src/include/utils/guc.h:432` `EXTRACT_PUSHDOWN_OR_CLAUSE`",
].join("\n");

const dispatch = (i) => ({
  span_id: `tool-a${i}`, kind: "tool", name: "Agent", trace_id: "trb",
  ts: `2026-09-12T02:00:0${i}Z`, tags: { agent_id: `a${i}` },
  input: JSON.stringify({ description: `Verify H1 in source ${i}` }),
  output_local: RETURN_WITH_REFS,
});
const subagent = (i) => ({
  span_id: `sub-a${i}`, parent_id: `tool-a${i}`, kind: "agent", name: "claude-code.subagent",
  trace_id: "trb", ts: `2026-09-12T02:00:1${i}Z`, tags: { agent_id: `a${i}` },
  output_local: RETURN_WITH_REFS,
});

describe("graph-worker · 代码证据的预算（模型端点挂掉时）", () => {
  it("端点永不应答时，在预算内收手并照常出图——工具边一条不少", async () => {
    // 永不应答的假模型端点：连接得上、请求收得下、就是不回。
    const hung = http.createServer(() => {});
    await new Promise((r) => hung.listen(0, "127.0.0.1", r));
    const llmPort = hung.address().port;

    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "obs-budget-"));
    fs.writeFileSync(path.join(dir, "sessB.json"), JSON.stringify({ trace_id: "trb", root_span_id: "trbroot", session_id: "sessB" }));
    const spans = [
      { span_id: "trbroot", parent_id: null, kind: "agent", name: "claude-code.task", trace_id: "trb", ts: "2026-09-12T02:00:00Z", output: "answer" },
      {
        // dbdog 调用的落盘形状见 synthesize.mjs：裸工具名 + tags.mcp_server，intent 是顶层字段。
        span_id: "d1", parent_id: "trbroot", kind: "tool", name: "get_dbdog_metric", trace_id: "trb",
        ts: "2026-09-12T02:00:30Z", tags: { mcp_server: "dbdog-mcp", hypothesis_id: "H1" },
        intent: "[H1] type=cause; claim=计划里没有基表 Filter; expect=看到全表扫",
        output: "rows",
      },
      ...[1, 2, 3, 4, 5].flatMap((i) => [dispatch(i), subagent(i)]),
    ];
    fs.writeFileSync(path.join(dir, "spans.jsonl"), spans.map((s) => JSON.stringify(s)).join("\n") + "\n");

    const startedAt = Date.now();
    const status = await new Promise((resolve) => {
      spawn(process.execPath, [path.join(import.meta.dirname, "graph-worker.mjs"), "sessB"], {
        env: {
          ...process.env,
          DBDOG_OBS_DIR: dir,
          DBDOG_OBS_REPORT_URL: "", // 不推 server，本用例只看落盘
          DBDOG_SUMMARY_LLM_BASE_URL: `http://127.0.0.1:${llmPort}`,
          DBDOG_SUMMARY_LLM_API_KEY: "k-test",
          DBDOG_SUMMARY_LLM_MODEL: "test-model",
          DBDOG_SOURCE_EVIDENCE_BUDGET_MS: "400",
          DBDOG_SOURCE_EVIDENCE_CONCURRENCY: "2",
        },
        stdio: "ignore",
      }).on("close", resolve);
    });
    const elapsed = Date.now() - startedAt;
    await new Promise((r) => hung.close(r));

    expect(status).toBe(0);
    // 预算 400ms + 进程启动；给到 15s 已经很松——串行 30s/条跑 5 条要两分半。
    expect(elapsed).toBeLessThan(15_000);

    const md = fs.readFileSync(path.join(dir, "graphs", "trb", "forward-path.md"), "utf8");
    expect(md).toContain("H1");
    expect(md).toContain("get_dbdog_metric"); // 不需要模型的工具边照出
    const log = fs.readFileSync(path.join(dir, "graph-worker.log"), "utf8");
    expect(log).toContain("代码证据边 0");
    expect(log).toMatch(/超预算未跑 \d+|判切分失败 \d+/); // 收手的原因要留在日志里
  }, 30_000);
});
