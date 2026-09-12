// backfill-root.mjs 的用例——守的是 2026-09-12 那次真实数据损坏：
// 回刷用本地 root 当推送载体，同键重发把服务端侧 tag（evaluation.verdict /
// mcp_version / skills_digest）全抹了，46 条 root 的判题裁决一次归零。
import { describe, expect, it } from "vitest";
import { isServerSideTag, rootForBackfill, serverTagDiff, withIngestTs, remoteReason } from "./backfill-root.mjs";

const remote = {
  trace_id: "aa", span_id: "r1", kind: "agent", ts: "2026-09-11T11:53:51.112Z",
  tags: {
    ml_app: "diagbench-runner",
    mcp_version: "0.1.23-dev.g239e8a0",
    skills_digest: "877cc8e6",
    "evaluation.verdict": "correct",
    "evaluation.trustworthy": "true",
  },
};
const local = { trace_id: "aa", span_id: "r1", kind: "agent", ts: "2026-09-11T11:53:51.112Z", tags: { ml_app: "diagbench-runner" } };

describe("isServerSideTag", () => {
  it("认三类：mcp_version / skills_digest / evaluation.* 前缀", () => {
    expect(isServerSideTag("mcp_version")).toBe(true);
    expect(isServerSideTag("skills_digest")).toBe(true);
    expect(isServerSideTag("evaluation.verdict")).toBe(true);
    expect(isServerSideTag("evaluation.whatever_new")).toBe(true); // 前缀匹配，新增判题标签自动纳入
    expect(isServerSideTag("ml_app")).toBe(false);
  });
});

describe("rootForBackfill", () => {
  it("以服务端那份为底，只改 graph——服务端侧 tag 一个不少", () => {
    const out = rootForBackfill(remote, { hello: 1 });
    expect(out.tags["evaluation.verdict"]).toBe("correct");
    expect(out.tags.mcp_version).toBe("0.1.23-dev.g239e8a0");
    expect(out.graph).toEqual({ hello: 1 });
  });

  it("拿不到服务端那份就返回 null——宁可不刷，也不要用本地版覆盖", () => {
    expect(rootForBackfill(null, {})).toBe(null);
    expect(rootForBackfill({ trace_id: "aa" }, {})).toBe(null); // 缺 span_id
  });
});

describe("serverTagDiff（推之前的自检）", () => {
  it("以服务端为底时无差异", () => {
    expect(serverTagDiff(remote, rootForBackfill(remote, {}))).toEqual([]);
  });

  it("用本地 root 当载体时，把被抹掉的键全列出来——这正是那次事故", () => {
    const bad = serverTagDiff(remote, { ...local, graph: {} });
    expect(bad).toContain("evaluation.verdict");
    expect(bad).toContain("evaluation.trustworthy");
    expect(bad).toContain("mcp_version");
    expect(bad).toContain("skills_digest");
    expect(bad).not.toContain("ml_app"); // 本地也有，不算破坏
  });

  it("改值也算破坏，不只是缺失", () => {
    const tampered = { ...remote, tags: { ...remote.tags, mcp_version: "0.1.23-dev.ga669a70" } };
    expect(serverTagDiff(remote, tampered)).toEqual(["mcp_version"]);
  });
});

describe("withIngestTs（读回参 ts_ms → 摄入口 ts）", () => {
  it("毫秒转 ISO 串，ts_ms 去掉", () => {
    const o = withIngestTs({ span_id: "r1", ts_ms: 1789127631112 });
    expect(o.ts).toBe(new Date(1789127631112).toISOString());
    expect(o.ts_ms).toBeUndefined();
  });
  it("已经有 ts 就不动", () => {
    expect(withIngestTs({ ts: "2026-09-11T11:53:51.112Z", ts_ms: 1 }).ts).toBe("2026-09-11T11:53:51.112Z");
  });
  it("rootForBackfill 顺带转——不转整条会被摄入口拒（2026-09-12 实测「推失败」）", () => {
    const out = rootForBackfill({ trace_id: "aa", span_id: "r1", ts_ms: 1789127631112, tags: {} }, {});
    expect(typeof out.ts).toBe("string");
    expect(out.ts_ms).toBeUndefined();
  });
});

describe("serverTagDiff 也守正文字段", () => {
  it("model / intent 被抹空算破坏——spans/search 的投影里本来就没这两个", () => {
    const remoteFull = { ...remote, model: "deepseek-v4-flash", intent: "[H1] …" };
    const fromSearch = { ...local, graph: {} }; // 搜索回参没有 model/intent
    const bad = serverTagDiff(remoteFull, fromSearch);
    expect(bad).toContain("model");
    expect(bad).toContain("intent");
  });
  it("服务端那份本来就空的字段不算破坏", () => {
    const out = rootForBackfill(remote, {});
    expect(serverTagDiff(remote, out)).toEqual([]);
  });
});

// 回刷把「拉服务端 root」提到了最前面当过滤器用（2026-09-12），于是必须分清三件事：
// 服务端确实没有（404，跳过是对的）／取不到（连不上、5xx，**这条要重跑**）／拿到了。
// 压成同一个 null 的话，服务端抖一下就会让那段时间的 trace 全被静默丢掉，跑完还报成功。
describe("remoteReason", () => {
  it("404 是「没有」，连不上和 5xx 是「取不到」，两者不能混", () => {
    expect(remoteReason(null)).toBe("unreachable"); // fetch 直接抛（隧道断/服务没起）
    expect(remoteReason({ ok: false, status: 404 })).toBe("absent");
    expect(remoteReason({ ok: false, status: 502 })).toBe("unreachable");
    expect(remoteReason({ ok: false, status: 500 })).toBe("unreachable");
    expect(remoteReason({ ok: false, status: 401 })).toBe("unreachable"); // 鉴权错也不是「没有」
    expect(remoteReason({ ok: true, status: 200 })).toBe("ok");
  });
});
