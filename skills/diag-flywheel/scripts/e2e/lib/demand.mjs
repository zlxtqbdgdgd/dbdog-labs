// demand.mjs — 单文件 demand.jsonl：按 intent 前缀切片；真源在 rounds/.telemetry/round-NN/。
import fs from "node:fs";
import path from "node:path";
import {
  ensureTelemetryLayout, roundNumberFromDir, telemetryDir,
} from "./round-fs.mjs";
import { sanitizeRunSuffix } from "./round-meta.mjs";

export function intentPrefix(round, num, suffix = "") {
  const base = `R${String(round).padStart(2, "0")}S${num}:`;
  const clean = sanitizeRunSuffix(suffix);
  return clean ? `${base}${clean}:` : base;
}

/** 从 intent 解析轮次、用例编号、模型 suffix（legacy 无 suffix 时为空串）。 */
export function parseIntent(intent) {
  const m = String(intent || "").match(/^R(\d+)S(\d{3})(?::([^:]*):)?/);
  if (!m) return null;
  return { round: Number(m[1]), num: m[2], suffix: m[3] || "" };
}

/** 按 run-suffix 切片；无 suffix 数据时回退 legacy intent。 */
export function sliceForCase(roundDir, round, num, suffix = "") {
  const file = demandPath(roundDir);
  const clean = sanitizeRunSuffix(suffix);
  if (clean) {
    const scoped = sliceFromFile(file, intentPrefix(round, num, clean));
    if (scoped.some((r) => r._e2e === "agent_prose") || toolRecords(scoped).length) return scoped;
  }
  return sliceFromFile(file, intentPrefix(round, num));
}

function e2eFromRoundDir(roundDir) {
  return path.resolve(roundDir, "../..");
}

/** 遥测在 rounds/.telemetry/round-NN/demand.jsonl；自动迁移旧路径。 */
export function demandPath(roundDir) {
  const round = roundNumberFromDir(roundDir);
  const e2e = e2eFromRoundDir(roundDir);
  if (round == null) throw new Error(`invalid round dir: ${roundDir}`);

  ensureTelemetryLayout(e2e, round);
  const dest = path.join(telemetryDir(e2e, round), "demand.jsonl");

  const legacy = [
    path.join(roundDir, ".cache", "demand.jsonl"),
    path.join(roundDir, "demand.jsonl"),
  ];
  if (!fs.existsSync(dest)) {
    for (const old of legacy) {
      if (fs.existsSync(old)) {
        fs.renameSync(old, dest);
        break;
      }
    }
  }
  return dest;
}

export function readLines(file) {
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, "utf8").split("\n").filter(Boolean);
}

export function parseRecords(lines) {
  const out = [];
  for (const line of lines) {
    try { out.push(JSON.parse(line)); } catch { /* skip */ }
  }
  return out;
}

export function readAll(file) {
  return parseRecords(readLines(file));
}

/** MCP 工具调用记录（排除 _e2e 元数据行）。 */
export function toolRecords(records) {
  return records.filter((r) => !r._e2e);
}

export function cleanAgentProse(text) {
  return String(text ?? "").replace(/```json\s*[\s\S]*?```\s*$/, "").trim();
}

export function agentProseFromRecords(records) {
  const row = records.find((r) => r._e2e === "agent_prose");
  return row ? cleanAgentProse(row.prose) : "";
}

export function sliceRecords(records, prefix) {
  return records.filter((r) => String(r.intent || "").startsWith(prefix));
}

export function sliceFromFile(file, prefix) {
  return sliceRecords(readAll(file), prefix);
}

/** 从 demand.jsonl 列出已有用例编号（按 intent 前缀）。 */
export function caseNumsInDemand(file, round) {
  const pfx = `R${String(round).padStart(2, "0")}S`;
  const nums = new Set();
  for (const r of readAll(file)) {
    const m = new RegExp(`^${pfx}(\\d{3})`).exec(r.intent || "");
    if (m) nums.add(m[1]);
  }
  return [...nums].sort();
}

/** --only 重跑前：删掉该用例在合并 demand 里的所有行。
 *  多引擎并行（how-to-run.md §多栈并行）时，不同 run-round-local 进程会并发 purge 同一
 *  demand.jsonl；existsSync 与 unlink 之间存在 TOCTOU 窗口，另一进程可能先 unlink → 本进程
 *  unlinkSync 抛 ENOENT 把整批跑死。unlink 失败（已不存在）按幂等处理。
 *  并发 rewrite 还可能与 appendFileSync 交错丢行：仅当确有匹配行被滤掉才 rewrite，
 *  否则原样保留（无该 case 旧记录 = 无需 purge），把并发窗口压到最小。 */
export function purgeCase(file, prefix) {
  if (!fs.existsSync(file)) return;
  const lines = readLines(file);
  let purged = 0;
  const kept = lines.filter((line) => {
    try {
      const d = JSON.parse(line);
      if (String(d.intent || "").startsWith(prefix)) { purged++; return false; }
      return true;
    } catch { return true; }
  });
  if (!purged) return; // 无该 case 旧记录，不动文件，避免并发 rewrite 丢他进程 append 的行
  if (kept.length) fs.writeFileSync(file, kept.join("\n") + "\n");
  else { try { fs.unlinkSync(file); } catch { /* 已被并发进程删，幂等 */ } }
}

export function appendLines(file, lines) {
  fs.appendFileSync(file, lines.map((l) => (typeof l === "string" ? l : JSON.stringify(l))).join("\n") + "\n");
}

export function appendToolLog(file, records) {
  if (!records.length) return;
  appendLines(file, records);
}

/**
 * 工具名 / ToolSearch 一律以最新 origin 采集为准：**不剥 mcp__ 前缀、不滤 harness 元工具**
 * （ADR-0007 后两栈都走 stream-json，形状本就对称）。唯一整形：把 required 入参
 * args.telemetry.intent 的语义 intent 提上来（加 case 前缀供 slice 命中），修 origin 里
 * `intent: prefix` 覆盖导致的 intent 丢失。缺失（如 ToolSearch 无此入参）则只留前缀。
 * outcome（is_error→"error"）由 stream 收集器写好，{...t} 原样带过。
 */
export function attachCaseIntent(toolCalls, prefix) {
  return (toolCalls || []).map((t) => ({
    ...t,
    intent: `${prefix} ${t.args?.telemetry?.intent ?? ""}`.trim(),
  }));
}

export function appendAgentProse(file, prefix, prose) {
  appendLines(file, [{
    _e2e: "agent_prose",
    intent: prefix,
    ts: new Date().toISOString(),
    prose: cleanAgentProse(prose),
  }]);
}

/** 一次性：把旧版 demand-NNN + ans-NNN 并入 demand.jsonl，再删旧文件。 */
export function migrateLegacyRoundDir(roundDir, round) {
  if (!fs.existsSync(roundDir)) return;
  const merged = demandPath(roundDir);
  const pfx = `R${String(round).padStart(2, "0")}S`;
  for (const f of fs.readdirSync(roundDir)) {
    const dm = f.match(/^demand-(\d{3})\.jsonl$/);
    if (!dm) continue;
    const num = dm[1];
    const prefix = `${pfx}${num}:`;
    purgeCase(merged, prefix);
    const toolLines = readLines(`${roundDir}/${f}`);
    if (toolLines.length) appendLines(merged, toolLines);
    const ans = `${roundDir}/ans-${num}.txt`;
    if (fs.existsSync(ans)) {
      const prose = fs.readFileSync(ans, "utf8");
      if (prose.trim()) appendAgentProse(merged, prefix, prose);
    }
  }
  cleanLegacyArtifacts(roundDir);
}

/** 清掉 round 内旧版中间目录/文件。 */
export function cleanLegacyArtifacts(roundDir) {
  if (!fs.existsSync(roundDir)) return;
  for (const name of [".cache", "prompts"]) {
    const p = path.join(roundDir, name);
    if (fs.existsSync(p)) {
      try { fs.rmSync(p, { recursive: true, force: true }); } catch { /* */ }
    }
  }
  for (const f of fs.readdirSync(roundDir)) {
    if (/^(ans-\d{3}\.txt|demand-\d{3}\.jsonl|demand\.jsonl|cfg-\d{3}\.json|run-\d{3}\.log|gaps\.json|interface\.json)$/.test(f)) {
      try { fs.unlinkSync(`${roundDir}/${f}`); } catch { /* */ }
    }
  }
}

/** 从上一轮 index.html 提取「通用排查纪律」反哺 prompt。 */
export function priorGuidanceFromIndex(indexHtml) {
  const m = indexHtml.match(/通用排查纪律[^<]*<ol>([\s\S]*?)<\/ol>/i);
  if (!m) return [];
  return [...m[1].matchAll(/<li>([^<]*)<\/li>/g)].map((x) => x[1].trim()).filter(Boolean);
}
