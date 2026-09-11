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
