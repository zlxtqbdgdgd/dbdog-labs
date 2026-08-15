#!/usr/bin/env node
// SessionStart — 干两件事：① 把 sweep.mjs 甩到后台去收尸；② 检查上报 env 是不是还留着模板占位。
//
// 为什么要 detached：收尸可能要补发几百条 span、发好几轮 HTTP（每轮 3s 超时）。
// 会话启动时用户在等，绝不能把这段耗时压在启动路径上。detached + unref 之后
// 本进程立即退出，sweep 在后台自己跑完。
//
// 为什么挂 SessionStart 而不是 Stop：stop.mjs 开头就因触发门提前返回
// （`!state?.trace_id || state.active === false`），triggered 模式下绝大多数会话
// 根本不触发——而积压恰恰发生在"观测开过、然后会话结束"之后，越需要收尸越轮不到它。
// SessionStart 与触发门无关，每次开会话都跑。
//
// 占位自检：只抓"模板占位没替换"这种明确误配（<…> / ABSOLUTE/PATH / change-me / dbdog-mcp地址）。
// 空值不报——那是合法的"只落本地、不上报"模式。警告走 stderr，绝不阻断会话。
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { readStdinJson, run } from "./lib.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));

function isPlaceholder(v) {
  const s = (v ?? "").trim();
  if (!s) return false; // 空值 = 合法的只跑本地模式，不算占位
  return (
    s.includes("ABSOLUTE/PATH") ||
    s.startsWith("<") ||
    /<[^>]+>/.test(s) ||
    s === "change-me" ||
    s.includes("dbdog-mcp地址")
  );
}

function checkConfig() {
  const warns = [];
  if (isPlaceholder(process.env.DBDOG_OBS_API_KEY)) warns.push("DBDOG_OBS_API_KEY 仍是占位");
  if (isPlaceholder(process.env.DBDOG_OBS_REPORT_URL)) warns.push("DBDOG_OBS_REPORT_URL 仍是占位");
  if (warns.length) {
    console.error(
      `⚠ [dbdog-obs] 配置未就绪：${warns.join("；")}，LLMObs 上报会失败。跑 \`node install.mjs\` 一把配好（或手改 settings.json 的 env 块）。`,
    );
  }
}

run(async () => {
  checkConfig();

  // 先甩出去再读 stdin——万一 stdin 是坏 JSON，也不能耽误收尸
  try {
    const child = spawn(process.execPath, [path.join(HERE, "sweep.mjs")], {
      detached: true,
      stdio: "ignore",
      env: process.env,
    });
    child.once("error", () => {}); // spawn 的运行期失败走异步 error 事件,不接住会崩掉 hook
    child.unref();
  } catch {
    /* 起不来就算了，下次会话再试；绝不打断会话 */
  }

  // 把 stdin 读掉，免得写侧拿到 EPIPE
  try {
    await readStdinJson();
  } catch {
    /* hook 不关心内容 */
  }
});
