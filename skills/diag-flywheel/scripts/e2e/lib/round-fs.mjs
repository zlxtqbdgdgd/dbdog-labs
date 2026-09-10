// round-fs.mjs — 轮次目录编号；遥测在 rounds/.telemetry/（不进 round-NN/）。
import fs from "node:fs";
import path from "node:path";
import { listRoundRuns, parseRoundDirName, roundRunDirName } from "./round-meta.mjs";

export function roundsRoot(e2e) {
  return path.join(e2e, "rounds");
}

export function telemetryRoot(e2e) {
  return path.join(roundsRoot(e2e), ".telemetry");
}

/** rounds/.telemetry/round-NN/ — demand.jsonl（不进 round-NN/） */
export function telemetryDir(e2e, round) {
  return path.join(telemetryRoot(e2e), `round-${String(round).padStart(2, "0")}`);
}

export function roundDirName(round) {
  return roundRunDirName(round);
}

export function roundNumberFromDir(roundDir) {
  return parseRoundDirName(path.basename(roundDir))?.round ?? null;
}

export function listRoundNumbers(e2e) {
  return [...new Set(listRoundRuns(e2e).map((r) => r.round))].sort((a, b) => a - b);
}

export function latestRoundNumber(e2e) {
  const nums = listRoundNumbers(e2e);
  return nums.length ? nums.at(-1) : null;
}

export function nextRoundNumber(e2e) {
  const latest = latestRoundNumber(e2e);
  return latest == null ? 1 : latest + 1;
}

/** round-NN/ 只放 scenario-nl + 报告 HTML。 */
export function ensureRoundLayout(roundDir) {
  fs.mkdirSync(roundDir, { recursive: true });
}

export function ensureTelemetryLayout(e2e, round) {
  fs.mkdirSync(telemetryDir(e2e, round), { recursive: true });
}
