// run-artifacts.mjs —— 一轮跑批的本地产物落点（span / 状态文件 / 假设图）。
//
// 2026-09-11 owner 定：**别用 tmp**，落到 dbdog-labs 仓下的 `dbdog-obs/runs/<experiment>/`。
// 此前是 `fs.mkdtempSync(os.tmpdir() + "llmobs-exp-")`：随机后缀、路径只 console.error 打一次、
// 不落任何持久位置——事后要回看本地原始 span 得先去 /var/folders 里翻目录猜哪个是哪一轮
// （当天实际发生过一次，翻到了默认目录 ~/.claude/dbdog-obs 的空盒子上，据此下了错结论）；
// 而 /var/folders 还会被系统定期清掉，证据窗口有限且不可预期。
//
// 换成**可由 (labsRoot, experiment) 推算**的固定路径后，不用记也找得到，
// span-graph 那类离线工具直接把这个目录喂进去就行。
//
// 注意这里只放产物，不放凭证：mcp.json 里有 MCP bearer，仍留在临时目录，
// 不进 git 工作树（家规：凭证只走环境变量，不写进仓库）。
import fs from "node:fs";
import path from "node:path";

/**
 * experiment 名进路径前的净化：只留 `[A-Za-z0-9._-]`，其余一律换 `_`。
 * experiment 名来自 `--experiment`（loop 自己生成的是 `diag-loop-<日期>-<时分>`，但这是个
 * 外部可给的参数），不净化的话一个 `/` 或 `..` 就能写到 runs/ 外面去。
 */
export function safeSegment(name) {
  const cleaned = String(name ?? "").replace(/[^A-Za-z0-9._-]/g, "_");
  // 纯点开头（`.` / `..`）单靠字符白名单挡不住，得单独压掉
  const safe = cleaned.replace(/^\.+/, (m) => "_".repeat(m.length));
  return safe || "unnamed";
}

/**
 * `<labsRoot>/dbdog-obs/runs/<experiment>/`。
 *
 * 同名 experiment 再跑一次**不复用**同一个目录：两轮的 spans.jsonl 追加在一起，读侧按
 * trace 筛得动、但状态文件会互相覆盖。默认名精确到分钟，30 分钟一轮的 loop 撞不上，
 * 手工连着跑会撞——撞上就挂 run id 短前缀区分（run id 是控制面主键，天然唯一）。
 */
export function runArtifactsDir(labsRoot, experiment, runID = "") {
  const runs = path.join(labsRoot, "dbdog-obs", "runs");
  const seg = safeSegment(experiment);
  const first = path.join(runs, seg);
  if (!fs.existsSync(first)) return first;
  const tag = safeSegment(String(runID).replace(/-/g, "").slice(0, 8) || String(Date.now()));
  return path.join(runs, `${seg}-${tag}`);
}
