import fs from "node:fs";
import path from "node:path";

export const ROUND_RETENTION_LIMIT = 3;

export function padRound(round) {
  return String(round).padStart(2, "0");
}

// DD-* run-suffix 表示该 run 用 Datadog 官方栈当 oracle 标尺（如 DD-Sonnet-5），非被测系统 dbdog。
// 收轮 index / interface / 跨轮看板只展示 dbdog，故某轮同时含 dbdog run 与 DD-* oracle run 时剔除后者
// （how-to-analyze 步骤 7 硬约定「index 只 dbdog，对照归分析」）。纯 oracle 轮（如 round-06，全 DD-*）保留。
export function isOracleSuffix(suffix) {
  return /^DD[-_]/i.test(String(suffix || ""));
}

// 某轮同时有 dbdog run 时，从 run 列表里剔除 DD-* oracle run；纯 oracle 轮原样返回。
// items 元素需带 `suffix` 字段（或用 getSuffix 取）。
export function dropOracleWhenDbDog(items, getSuffix = (x) => x?.suffix) {
  const arr = [...items];
  if (arr.some((x) => !isOracleSuffix(getSuffix(x)))) {
    return arr.filter((x) => !isOracleSuffix(getSuffix(x)));
  }
  return arr;
}

export function sanitizeRunSuffix(value) {
  return String(value || "")
    .trim()
    .replace(/\s+/g, "-")
    .replace(/[\\/:"<>|?*]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

export function parseRoundDirName(name) {
  const m = String(name || "").match(/^round-(\d{2})(?:-(.+))?$/);
  if (!m) return null;
  return {
    round: Number(m[1]),
    rr: m[1],
    suffix: m[2] || "",
    dirName: name,
    label: name,
  };
}

/** 轮次目录恒为 round-NN；run-suffix 只用于 case 文件名与 telemetry intent。 */
export function roundRunDirName(round) {
  return `round-${padRound(round)}`;
}

export function caseFileName(num, suffix = "") {
  const clean = sanitizeRunSuffix(suffix);
  return clean ? `case-${num}-${clean}.html` : `case-${num}.html`;
}

export function parseCaseFileName(name) {
  const m = String(name || "").match(/^case-(\d{3})(?:-(.+))?\.html$/);
  if (!m) return null;
  return { num: m[1], suffix: m[2] || "" };
}

export function listCaseFiles(roundDir) {
  if (!fs.existsSync(roundDir)) return [];
  return fs.readdirSync(roundDir)
    .map((name) => {
      const parsed = parseCaseFileName(name);
      return parsed ? { ...parsed, name } : null;
    })
    .filter(Boolean)
    .sort((a, b) => a.num.localeCompare(b.num) || a.suffix.localeCompare(b.suffix));
}

export function resolveRunSuffix(argv = process.argv) {
  const arg = (name) => {
    const i = argv.indexOf(`--${name}`);
    return i >= 0 ? argv[i + 1] : "";
  };
  return sanitizeRunSuffix(
    arg("run-suffix")
    || process.env.E2E_RUN_SUFFIX
    || process.env.E2E_MODEL
    || arg("model")
    || "",
  );
}

/** Read round-NN/round.json if present. */
export function readRoundMeta(roundDir) {
  const file = path.join(roundDir, "round.json");
  if (!fs.existsSync(file)) return null;
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

/** Instance key for bucketing cross-round indexes (never mix engines). */
export function roundInstanceKey(run) {
  const meta = readRoundMeta(run.dir);
  if (meta?.instance) return String(meta.instance);
  if (meta?.engine) return `engine:${meta.engine}`;
  return "unspecified";
}

/** 跨轮看板只读 MCP 当前树；超过保留上限时拒绝静默截断。
 *  When instanceFilter is set, only that instance's rounds are considered.
 *  Otherwise callers should prefer listIndexedRoundRunsGrouped. */
export function listIndexedRoundRuns(e2e, limit = ROUND_RETENTION_LIMIT, instanceFilter = "") {
  if (!Number.isInteger(limit) || limit < 1) throw new RangeError("round retention limit must be a positive integer");
  const runs = listRoundRuns(e2e);
  if (runs.length > limit) {
    throw new Error(`MCP 当前树有 ${runs.length} 个 round 目录，超过最近 ${limit} 轮保留策略；请先用 finish-round 收轮清理。`);
  }
  let out = runs.filter((r) => r.round >= 2);
  if (instanceFilter) {
    out = out.filter((r) => roundInstanceKey(r) === instanceFilter);
  }
  return out;
}

/** Group recent rounds by instance key — PG and Gauss never share one trend window. */
export function listIndexedRoundRunsGrouped(e2e, limit = ROUND_RETENTION_LIMIT) {
  const runs = listIndexedRoundRuns(e2e, limit);
  const groups = new Map();
  for (const r of runs) {
    const key = roundInstanceKey(r);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(r);
  }
  const out = [];
  for (const [instance, list] of [...groups.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
    out.push({ instance, runs: list });
  }
  return out;
}

/** 每轮一条；目录固定 round-NN（legacy round-NN-SUFFIX 目录仍计入 round 编号）。 */
export function listRoundRuns(e2e) {
  const root = path.join(e2e, "rounds");
  if (!fs.existsSync(root)) return [];
  const byRound = new Map();
  for (const name of fs.readdirSync(root)) {
    const parsed = parseRoundDirName(name);
    if (!parsed) continue;
    const fullDir = path.join(root, name);
    if (!fs.statSync(fullDir).isDirectory()) continue;
    const dirName = roundRunDirName(parsed.round);
    byRound.set(parsed.round, {
      round: parsed.round,
      rr: parsed.rr,
      suffix: "",
      dirName,
      label: dirName,
      dir: path.join(root, dirName),
    });
  }
  return [...byRound.values()].sort((a, b) => a.round - b.round);
}

/**
 * 把 MCP 当前树收敛到最近 limit 轮，并同步删除更早轮次的本地遥测。
 * round-NN 不靠 .gitignore 隐藏；历史只通过 Git 历史恢复。
 */
export function enforceRoundRetention(e2e, limit = ROUND_RETENTION_LIMIT) {
  if (!Number.isInteger(limit) || limit < 1) throw new RangeError("round retention limit must be a positive integer");
  const root = path.join(e2e, "rounds");
  const runs = listRoundRuns(e2e);
  const kept = runs.slice(-limit);
  const removed = runs.slice(0, Math.max(0, runs.length - limit));
  const removedRounds = new Set(removed.map((run) => run.round));
  const keptRounds = new Set(kept.map((run) => run.round));

  if (fs.existsSync(root) && removedRounds.size) {
    for (const name of fs.readdirSync(root)) {
      const parsed = parseRoundDirName(name);
      if (!parsed || !removedRounds.has(parsed.round)) continue;
      const dir = path.join(root, name);
      if (fs.statSync(dir).isDirectory()) fs.rmSync(dir, { recursive: true, force: true });
    }
  }

  const telemetryRoot = path.join(root, ".telemetry");
  const removedTelemetry = [];
  if (fs.existsSync(telemetryRoot)) {
    for (const name of fs.readdirSync(telemetryRoot)) {
      const parsed = parseRoundDirName(name);
      if (!parsed || keptRounds.has(parsed.round)) continue;
      const dir = path.join(telemetryRoot, name);
      if (!fs.statSync(dir).isDirectory()) continue;
      fs.rmSync(dir, { recursive: true, force: true });
      removedTelemetry.push(name);
    }
  }

  return { kept, removed, removedTelemetry: removedTelemetry.sort() };
}

export function resolveRoundRun(e2e, round, suffix = resolveRunSuffix()) {
  const rr = padRound(round);
  const dirName = roundRunDirName(round);
  const clean = sanitizeRunSuffix(suffix);
  return {
    round,
    rr,
    suffix: clean,
    dirName,
    label: dirName,
    dir: path.join(e2e, "rounds", dirName),
  };
}

/** 把 legacy round-NN-<model>/ 下的 case 与 scenario-nl 并入 round-NN/。 */
export function consolidateLegacyModelDirs(e2e, round) {
  const root = path.join(e2e, "rounds");
  const canonical = path.join(root, roundRunDirName(round));
  fs.mkdirSync(canonical, { recursive: true });
  const rr = padRound(round);
  let moved = 0;

  for (const name of fs.readdirSync(root)) {
    const parsed = parseRoundDirName(name);
    if (!parsed || parsed.round !== round || !parsed.suffix) continue;
    const legacyDir = path.join(root, name);
    if (!fs.statSync(legacyDir).isDirectory()) continue;

    for (const file of fs.readdirSync(legacyDir)) {
      const dest = path.join(canonical, file);
      if (file === "scenario-nl.json" && fs.existsSync(dest)) continue;
      if (/^case-\d{3}(?:-.+)?\.html$/.test(file)) {
        if (fs.existsSync(dest)) fs.unlinkSync(dest);
        fs.renameSync(path.join(legacyDir, file), dest);
        moved++;
        continue;
      }
      if (file === "scenario-nl.json" || file.startsWith("分析-")) {
        if (!fs.existsSync(dest)) fs.renameSync(path.join(legacyDir, file), dest);
        continue;
      }
      if (file === "index.html" || file === "interface-analysis.html") {
        try { fs.unlinkSync(path.join(legacyDir, file)); } catch { /* */ }
        continue;
      }
      if (!fs.existsSync(dest)) fs.renameSync(path.join(legacyDir, file), dest);
    }

    const remaining = fs.readdirSync(legacyDir).filter((f) => f !== ".DS_Store");
    if (!remaining.length) fs.rmdirSync(legacyDir);
  }

  return { dir: canonical, moved };
}
