// agent-identity.mjs —— 「这一轮到底是谁在被测」。
//
// ## 为什么需要它
// 不传 `--model` 时，headless claude 子进程走的是**环境变量**：`ANTHROPIC_BASE_URL` +
// `ANTHROPIC_MODEL`（本机 2026-09-11 实测是 `api.deepseek.com/anthropic` +
// `deepseek-v4-flash[1M]`，从 ~/.claude/settings.json 的 env 块继承）。
// 而 run metadata 此前在这种情况下记的是字面量 `"default"` ——**那是假的**：
// 换台机器、或者哪天把那两行改了，被测模型就悄悄换了，跑批照跑、分数照记，
// 事后一点痕迹都没有。评测里最不该含糊的就是这个。
//
// corpus 那条老 loop 处理过同一件事（diagnose.sh 读配置目录的 ANTHROPIC_MODEL 写进 span 的
// sut_model tag）。这里把它收成一个函数，两条路共用一个口径。
//
// **只读不猜**：拿不到就如实回 unknown，不去推断「大概是 opus 吧」。

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/** 把 `deepseek-v4-flash[1M]` 这类带后缀的模型名留原样——后缀是档位，抹掉就分不出跑的哪一档。 */
export function resolveAgentIdentity({ model, env = process.env } = {}) {
  // 显式 --model 最优先：调用方指定了就是它，不看环境。
  if (model) return { model, source: "flag", endpoint: endpointOf(env) };
  const fromEnv = (env.ANTHROPIC_MODEL || "").trim();
  if (fromEnv) return { model: fromEnv, source: "env", endpoint: endpointOf(env) };
  // 两样都没有 ⇒ 子进程会用 CLI 自己的默认，那个值本进程看不见。
  return { model: "unknown", source: "cli-default", endpoint: endpointOf(env) };
}

/** 端点也要记：同一个模型名在不同网关后面可能是不同东西。 */
function endpointOf(env) {
  const base = (env.ANTHROPIC_BASE_URL || "").trim();
  if (!base) return "anthropic";
  try {
    return new URL(base).host;
  } catch {
    return base.slice(0, 80);
  }
}

/**
 * 把 `--model opus` 这类**别名**放到某个配置目录里解开。
 *
 * ## 为什么需要
 * `opus` 不是一个模型，是一份配置里的一个槽位。本机三份配置把同一个别名指向三个模型：
 * `~/.claude-max` → `opus[1m]`、`~/.claude-glm` → `glm-5.3`、`~/.claude` → `deepseek-v4-pro[1M]`。
 * 判官 2026-09-12 从 claude-max 换到 claude-glm 之后，如果 `annotator` 还只记别名，
 * 新行与老行都写着 `opus` 却指两个模型——**而且静默**。而 annotator 存在的理由正是
 * 「两轮结论不一样时分得清是 agent 变了还是判官换了」，记一个解不开的别名等于把它作废。
 *
 * ## 只读不猜
 * 配置里没有对应那一行（订阅登录态的 `~/.claude-max` 就没有 env 块，`opus` 具体是哪一版
 * 只有 CLI 自己知道）就如实回 `unresolved` 并留着别名。**编一个模型名比留别名更坏**。
 *
 * @param {{alias: string, configDir?: string}} opts
 * @returns {{alias: string, model: string, endpoint: string, source: "config"|"literal"|"unresolved"}}
 */
export function resolveConfiguredModel({ alias, configDir = process.env.CLAUDE_CONFIG_DIR } = {}) {
  const name = String(alias ?? "").trim();
  const ALIASES = { opus: "ANTHROPIC_DEFAULT_OPUS_MODEL", sonnet: "ANTHROPIC_DEFAULT_SONNET_MODEL", haiku: "ANTHROPIC_DEFAULT_HAIKU_MODEL" };
  const env = readSettingsEnv(configDir);
  const endpoint = endpointOf(env);
  // 不是别名 = 调用方直接写了模型名：原样用，不去配置里找（找了也只会找错）。
  if (!ALIASES[name]) return { alias: name, model: name, endpoint, source: "literal" };
  const resolved = String(env[ALIASES[name]] ?? "").trim();
  if (!resolved) return { alias: name, model: name, endpoint, source: "unresolved" };
  return { alias: name, model: resolved, endpoint, source: "config" };
}

/** 读配置目录的 settings.json 的 env 块；读不到一律回空对象（缺配置不是异常，是常态）。 */
function readSettingsEnv(configDir) {
  if (!configDir) return {};
  try {
    const raw = fs.readFileSync(path.join(expandHome(configDir), "settings.json"), "utf8");
    const env = JSON.parse(raw)?.env;
    return env && typeof env === "object" ? env : {};
  } catch {
    return {};
  }
}

/** `~/.claude-glm` 这种写法在命令行里很常见，展开它——不展开就永远读不到那份配置。 */
function expandHome(p) {
  const s = String(p);
  return s.startsWith("~/") ? path.join(os.homedir(), s.slice(2)) : s;
}
