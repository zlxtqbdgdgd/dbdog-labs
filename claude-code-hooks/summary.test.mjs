import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { trimSpans, buildPrompt, generateSummary, summaryEnv, SYSTEM_PROMPT } from "./summary.mjs";

const baseEnv = {
  DBDOG_SUMMARY_LLM_BASE_URL: "https://open.bigmodel.cn/api/anthropic",
  DBDOG_SUMMARY_LLM_API_KEY: "sk-test",
};

// 清 DBDOG_SUMMARY_LLM_* + ANTHROPIC_*——后者尤其关键：开发机常驻 ANTHROPIC_AUTH_TOKEN，
// 不清会让"全空→null"类断言在该机器上误判，也跨用例互相串味。
const ENV_KEYS = [
  "DBDOG_SUMMARY_LLM_BASE_URL",
  "DBDOG_SUMMARY_LLM_API_KEY",
  "DBDOG_SUMMARY_LLM_MODEL",
  "DBDOG_SUMMARY_LLM_TIMEOUT_MS",
  "ANTHROPIC_BASE_URL",
  "ANTHROPIC_API_URL",
  "ANTHROPIC_AUTH_TOKEN",
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_MODEL",
];
const cleanEnv = () => {
  for (const k of ENV_KEYS) delete process.env[k];
};
beforeEach(cleanEnv);
afterEach(cleanEnv);

describe("summaryEnv", () => {
  it("未配 / 占位 → null（不出总结）", () => {
    expect(summaryEnv()).toBeNull();
    process.env.DBDOG_SUMMARY_LLM_BASE_URL = baseEnv.DBDOG_SUMMARY_LLM_BASE_URL;
    process.env.DBDOG_SUMMARY_LLM_API_KEY = "change-me";
    expect(summaryEnv()).toBeNull();
    process.env.DBDOG_SUMMARY_LLM_API_KEY = "<填GLM key>";
    expect(summaryEnv()).toBeNull();
  });

  it("配齐 → 返回 config，model 默认 glm-5.2", () => {
    Object.assign(process.env, baseEnv);
    const env = summaryEnv();
    expect(env).not.toBeNull();
    expect(env.model).toBe("glm-5.2");
    expect(env.timeoutMs).toBe(30_000);
    process.env.DBDOG_SUMMARY_LLM_MODEL = "glm-4";
    expect(summaryEnv().model).toBe("glm-4");
    // Claude Code 路由后缀 [1m] 会被剥掉（裸 GLM API 不认，否则 HTTP 400）
    process.env.DBDOG_SUMMARY_LLM_MODEL = "glm-5.2[1m]";
    expect(summaryEnv().model).toBe("glm-5.2");
  });
});

describe("summaryEnv · ANTHROPIC_* 回退", () => {
  it("DBDOG 缺、ANTHROPIC_* 在 → 复用 ANTHROPIC 凭据 + bigmodel host 默认 glm-5.2", () => {
    process.env.ANTHROPIC_BASE_URL = "https://open.bigmodel.cn/api/anthropic";
    process.env.ANTHROPIC_AUTH_TOKEN = "glm-token";
    const env = summaryEnv();
    expect(env).not.toBeNull();
    expect(env.baseUrl).toBe("https://open.bigmodel.cn/api/anthropic");
    expect(env.apiKey).toBe("glm-token");
    expect(env.model).toBe("glm-5.2");
  });

  it("DBDOG 显式值优先于 ANTHROPIC_*", () => {
    process.env.DBDOG_SUMMARY_LLM_BASE_URL = "https://dbdog.example/anthropic";
    process.env.DBDOG_SUMMARY_LLM_API_KEY = "dbdog-key";
    process.env.ANTHROPIC_AUTH_TOKEN = "should-not-win";
    const env = summaryEnv();
    expect(env.apiKey).toBe("dbdog-key");
    expect(env.baseUrl).toBe("https://dbdog.example/anthropic");
  });

  it("占位 apiKey 视同未配 → 回退到 ANTHROPIC_*", () => {
    process.env.DBDOG_SUMMARY_LLM_API_KEY = "<填GLM key>";
    process.env.ANTHROPIC_AUTH_TOKEN = "real-token";
    process.env.ANTHROPIC_BASE_URL = "https://open.bigmodel.cn/api/anthropic";
    const env = summaryEnv();
    expect(env).not.toBeNull();
    expect(env.apiKey).toBe("real-token");
  });

  it("baseUrl 全缺 → 兜底 api.anthropic.com，host 判定 → claude-haiku-4-5", () => {
    process.env.ANTHROPIC_AUTH_TOKEN = "claude-key";
    // 不设任何 BASE_URL → 兜底 https://api.anthropic.com
    const env = summaryEnv();
    expect(env.baseUrl).toBe("https://api.anthropic.com");
    expect(env.model).toBe("claude-haiku-4-5");
  });

  it("ANTHROPIC_MODEL 带 [路由后缀] 会被剥掉", () => {
    process.env.ANTHROPIC_AUTH_TOKEN = "tok";
    process.env.ANTHROPIC_BASE_URL = "https://open.bigmodel.cn/api/anthropic";
    process.env.ANTHROPIC_MODEL = "glm-5.2[1m]";
    expect(summaryEnv().model).toBe("glm-5.2");
  });
});

const sampleSpans = [
  { span_id: "root", kind: "agent", parent_id: null, ts: 0, output: "根因：rownum 绑定到 aggstate，ps_rownum 恒为 0，max(rownum)=1。" },
  { span_id: "t1", kind: "tool", name: "search_dbdog_database_samples", ts: 1000, intent: "找目标 SQL", tags: { mcp_server: "dbdog" }, output: "命中 0 条" },
  { span_id: "t2", kind: "tool", name: "search_dbdog_logs", ts: 2000, intent: "找目标 SQL", tags: { mcp_server: "dbdog" }, output: "0 matches" },
  { span_id: "t3", kind: "tool", name: "Read", ts: 3000, input: "nodeAgg.c", output: "rnstate->ps=parent\ncombined_inputeval aggstate" },
  { span_id: "t4", kind: "tool", name: "TaskCreate", ts: 4000, output: "todo" },
  { span_id: "l1", kind: "llm", ts: 5000, output: "我去查 [tool_use: search_dbdog_logs]" },
];

describe("trimSpans（Y 方案）", () => {
  const fact = trimSpans(sampleSpans);

  it("MCP 工具按 intent 归组、同 intent 合并、留信号行", () => {
    expect(fact).toContain("找目标 SQL");
    expect(fact).toContain("命中 0");
    expect(fact).toContain("0 matches");
  });

  it("代码证据（Read/Grep/Bash）保留 file/函数/行", () => {
    expect(fact).toContain("nodeAgg");
    expect(fact).toContain("aggstate");
  });

  it("agent 结论整段留", () => {
    expect(fact).toContain("根因：rownum 绑定到 aggstate");
  });

  it("丢 llm 与管理工具（TaskCreate、tool_use 标记）", () => {
    expect(fact).not.toContain("TaskCreate");
    expect(fact).not.toContain("[tool_use");
    expect(fact).not.toContain("todo");
  });
});

describe("buildPrompt", () => {
  it("system + user 双角色，system 含写作规则", () => {
    const prompt = buildPrompt("事实表");
    expect(prompt.map((m) => m.role)).toEqual(["system", "user"]);
    expect(prompt[0].content).toBe(SYSTEM_PROMPT);
    expect(SYSTEM_PROMPT).toContain("具体数值");
    expect(SYSTEM_PROMPT).toContain("起·承·转·合");
    expect(prompt[1].content).toBe("事实表");
  });
});

describe("generateSummary", () => {
  it("POST /v1/messages，从 content[].text 取正文，附 token", async () => {
    Object.assign(process.env, baseEnv);
    const env = summaryEnv();
    let captured;
    const origFetch = globalThis.fetch;
    globalThis.fetch = async (url, init) => {
      captured = { url: String(url), body: JSON.parse(init.body) };
      return new Response(
        JSON.stringify({ content: [{ type: "text", text: "一段诊断叙事。" }], usage: { input_tokens: 100, output_tokens: 20 } }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    };
    try {
      const out = await generateSummary(buildPrompt("事实表"), env);
      expect(out.text).toBe("一段诊断叙事。");
      expect(out.tokens_input).toBe(100);
      expect(out.tokens_output).toBe(20);
      expect(captured.url.endsWith("/v1/messages")).toBe(true);
      expect(captured.body.model).toBe("glm-5.2");
      expect(captured.body.messages.some((m) => m.role === "user")).toBe(true);
    } finally {
      globalThis.fetch = origFetch;
    }
  });

  it("HTTP 非 2xx / 空 content → 抛（上层 best-effort 吞）", async () => {
    Object.assign(process.env, baseEnv);
    const env = summaryEnv();
    const origFetch = globalThis.fetch;
    globalThis.fetch = async () => new Response("nope", { status: 429 });
    try {
      await expect(generateSummary(buildPrompt("x"), env)).rejects.toThrow(/HTTP 429/);
    } finally {
      globalThis.fetch = origFetch;
    }
  });
});

// —— 推理模型兼容（2026-08-14，47 圈巡检 45 圈无总结的根因）——
// deepseek-v4 系经 Anthropic 兼容端点是推理模型：thinking 块先行，max_tokens: 1024
// 全被 thinking 烧光，text 一个字没出就 stop_reason=max_tokens——generateSummary
// 报「空 content」，worker 静默死。两个成功圈只是模型碰巧想得短。
// 且成功回答实测 1194 output tokens > 1024：即便直答旧预算也会拦腰截断。
describe("generateSummary · 推理模型兼容", () => {
  const stubOk = (captures) => async (url, init) => {
    captures.push(JSON.parse(init.body));
    return new Response(
      JSON.stringify({ content: [{ type: "text", text: "总结正文。" }], usage: { input_tokens: 1, output_tokens: 2 } }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  };

  it("请求关掉 thinking 且 max_tokens 默认 2048", async () => {
    Object.assign(process.env, baseEnv);
    const env = summaryEnv();
    const calls = [];
    const orig = globalThis.fetch;
    globalThis.fetch = stubOk(calls);
    try {
      await generateSummary(buildPrompt("x"), env);
    } finally {
      globalThis.fetch = orig;
    }
    expect(calls).toHaveLength(1);
    expect(calls[0].thinking).toEqual({ type: "disabled" });
    expect(calls[0].max_tokens).toBe(2048);
  });

  it("DBDOG_SUMMARY_LLM_MAX_TOKENS 覆盖预算", async () => {
    Object.assign(process.env, baseEnv);
    process.env.DBDOG_SUMMARY_LLM_MAX_TOKENS = "4096";
    const env = summaryEnv();
    expect(env.maxTokens).toBe(4096);
    const calls = [];
    const orig = globalThis.fetch;
    globalThis.fetch = stubOk(calls);
    try {
      await generateSummary(buildPrompt("x"), env);
    } finally {
      globalThis.fetch = orig;
      delete process.env.DBDOG_SUMMARY_LLM_MAX_TOKENS;
    }
    expect(calls[0].max_tokens).toBe(4096);
  });

  it("thinking-only + max_tokens 截停 → 报错说清 stop_reason 与块型（可诊断，不再是裸『空 content』）", async () => {
    Object.assign(process.env, baseEnv);
    const env = summaryEnv();
    const orig = globalThis.fetch;
    globalThis.fetch = async () =>
      new Response(
        JSON.stringify({ stop_reason: "max_tokens", content: [{ type: "thinking", thinking: "……" }], usage: {} }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    try {
      await expect(generateSummary(buildPrompt("x"), env)).rejects.toThrow(/max_tokens.*thinking|thinking.*max_tokens/s);
    } finally {
      globalThis.fetch = orig;
    }
  });

  it("旧兼容端点 400 拒 thinking 字段 → 去掉该字段重试一次", async () => {
    Object.assign(process.env, baseEnv);
    const env = summaryEnv();
    const calls = [];
    const orig = globalThis.fetch;
    globalThis.fetch = async (url, init) => {
      const body = JSON.parse(init.body);
      calls.push(body);
      if (body.thinking) return new Response(JSON.stringify({ error: "unknown field: thinking" }), { status: 400 });
      return new Response(
        JSON.stringify({ content: [{ type: "text", text: "兼容端点正文。" }], usage: {} }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    };
    try {
      const out = await generateSummary(buildPrompt("x"), env);
      expect(out.text).toBe("兼容端点正文。");
    } finally {
      globalThis.fetch = orig;
    }
    expect(calls).toHaveLength(2);
    expect(calls[0].thinking).toEqual({ type: "disabled" });
    expect(calls[1].thinking).toBeUndefined();
  });
});

// codex 复审:4xx 全重试太宽——429(限流)双发是火上浇油;401/403 重试也无意义。
// thinking 字段的降级只针对 400(bad request,"不认这个字段"那一类)。
describe("generateSummary · thinking 降级只对 400", () => {
  it("429 不重试:只打一次就抛", async () => {
    Object.assign(process.env, baseEnv);
    const env = summaryEnv();
    const calls = [];
    const orig = globalThis.fetch;
    globalThis.fetch = async (url, init) => {
      calls.push(JSON.parse(init.body));
      return new Response("rate limited", { status: 429 });
    };
    try {
      await expect(generateSummary(buildPrompt("x"), env)).rejects.toThrow(/HTTP 429/);
    } finally {
      globalThis.fetch = orig;
    }
    expect(calls).toHaveLength(1);
  });
});
