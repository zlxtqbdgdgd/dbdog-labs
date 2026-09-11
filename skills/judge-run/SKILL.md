---
name: judge-run
description: 判一轮诊断——捞出「跑过但没判过」的诊断，一例一个会话按同插件 diag-judge 的口径判：结论对不对、证据撑不撑得住、改进点一条一条分六类；判完回流批注并把诊断表那行推到「待修」。在线是默认：有答案纸就从根因倒推该有哪些证据，逐条去活系统取到手。触发词：judge-run / 判题 / 判一轮 / 判诊断 / 判这批诊断。
---

# judge-run —— 判「这次诊断做得对不对」，并挖出 dbdog 该修什么

诊断飞轮的第三棒。`diag-run` 把复现跑成 trace，你判它。

产出两样：**这次判成什么**，以及 **dbdog 要修的条目**。后者才是这条 loop 的 KPI——
它的价值是「作为找 bug 的工具产出了多少 dbdog 的问题」，不是被测 agent 的命中率。
低命中率本身不是坏事，它是「这里有问题」的指示灯。

## 判据是差集，不是队列

跟 `diag-run` 不一样，这一棒**不抢队列**。诊断不只从批跑来：用户自己在 Claude Code 里
发一句「诊断: …」也会产出 trace，那种 trace 根本没有诊断表的行，但它同样该判。

所以待判集合是「跑过但没判过」现算的差集。诊断表那边**有行就把状态推到「待修」，
没有就跳过**——表是给人看进度的，不是判题的准入条件。

## 判题口径不在这里，在 `diag-judge`

判什么、怎么判、标签怎么填，单源在**同插件的 `diag-judge` skill**（2026-09-11 从 mcp 的
`llm-obs-diag-judge` 搬进插件）。**不要在这里复述一份**——它刚改过版，复述就是造第二个真相源。

两个 skill 的分工：`diag-judge` 管**怎么判一条 trace**，本 skill 管**捞哪些、跑几条、
判完推状态**。判一条的时候就去读它。

你只需要知道三件事，因为它们决定你**怎么起这个会话**：

**一、在线是默认，离线只在没有在线条件时。** 所以判题会话**必须挂 MCP**，这是硬要求。

**二、在线不止于看，要主动查证。** 判官手上有答案纸，就从根因倒推该有哪些证据，
逐条去活系统取到手——直查库表优先，取不到就换一条路取，再不行才原样复调一遍。
既证根因成立，也证 agent 该拿到而没拿到、dbdog 该给而没给。
**只看轨迹猜，「要不要修 dbdog」这一项判不出来。**

**三、探针与反向链只在离线时才是依赖。** 在线判题缺它们不算降级，别因为「没有探针结果」
就把结论判软——那是 2026-09-11 首轮重判踩过的坑：把在线当离线判，留了 5 条「判不出」。

这一棒**不需要禁读根**：判题方本来就该看见答案，它的活就是拿答案对轨迹。

## 跑

```bash
S=<diag-flywheel/scripts 目录>
CLAUDE_CONFIG_DIR=~/.claude-max   node $S/llmobs/loop-judge.mjs --dataset <用例集名> --timeout-sec 1800 [--limit N]
```

`CLAUDE_CONFIG_DIR` **不能省**，省了会 401，理由见下一节。

一例一个会话，不是一轮一个。早前按轮导过，三例材料叠起来 11 MB 塞进一个会话，
40 分钟没判完，而且一例失败整轮都不回流。

用户说「判 N 条」就把 N 传给 `--limit`。

## 判官用 opus，**而且必须切配置目录**（owner 2026-09-11 定）

| 角色 | 模型 | 怎么来 |
|---|---|---|
| 被诊断的 agent（`diag-run` 起的） | DeepSeek flash | `~/.claude/settings.json` 的 `env` 块 |
| **判官（本 skill 起的）** | **claude-max 的 opus** | **`CLAUDE_CONFIG_DIR=~/.claude-max`** |
| 重建链（判卷前 `loop-judge.mjs` 自动起的 `chain-rebuild.mjs`） | **跟考生同一个**（DeepSeek flash） | 脚本自己把子进程切到 `~/.claude`，**不跟判官的配置目录走**；`--chain-config-dir` 可改 |

考生用便宜快的、判官用强的：诊断要跑很多轮很长，成本在那儿；判卷判错了整条 loop 的产出
都不可信。

### 重建链是判卷前的一步，不是判卷的一部分（owner 2026-09-11 定）

账本是平铺的、报告里的因果链是多环的（三条线上 trace 实测 `parent_edges=0`），判官拿账本判会被带歪。
所以 `loop-judge.mjs` 导包之后、起判题会话之前，先对这一例跑一次 `chain-rebuild.mjs`：一次模型调用，
把 forward.md 那棵平铺账本读成语义因果链，写 `chain.json` / `chain.md` 进包里。判官按 `diag-judge`
里「重建链怎么用」那节用它——它是评测方的猜，和 forward.md 并排看，不改声明侧。

- 模型**跟诊断同一个**，脚本自己切 `CLAUDE_CONFIG_DIR=~/.claude`，你在外面套的 `~/.claude-max` 只管判官。
- 失败不拦判卷：stderr 一行 `✗ 重建链失败`，包里少两份文件，判官按 forward.md 判并在 summary 写「无重建链」。
- 不想跑加 `--no-chain`。本地单独调一例：`node $S/llmobs/chain-rebuild.mjs --case <pkg>/cases/<event_id> --strict`。
- 看输出：`✓ 重建链：声明深度 1 → 重建深度 2，判定冲突 1 处`——冲突数不为零的那几例，判官的改进点多半就在那里。

### 光传 `--judge-model opus` 不够，会 401

`~/.claude` 那份配置的 `env.ANTHROPIC_BASE_URL` 指着 DeepSeek 网关、key 也是 DeepSeek 的。
模型名传 opus 只会拿**DeepSeek 的 key 去那个端点要 opus**，2026-09-11 实测报：

```
Failed to authenticate. API Error: 401 Authentication Fails, Your api key: ****hgAA is invalid
```

claude-max 是**另一份配置目录**（`~/.claude-max`，走订阅登录态，没有 env 覆盖）。
切过去实测秒回。所以起判题会话时：

```bash
CLAUDE_CONFIG_DIR=~/.claude-max node $S/llmobs/loop-judge.mjs --dataset <用例集名> ...
```

跑之前确认 `~/.claude-max` 在、登录态没过期。**别用 flash 判**——判出来的结论不可信，
而且这个错是静默的：判题照跑、分数照记。

## 看输出

- `诊断表里待判题 N 条` —— 有表行的那批。
- `本轮判题：成 X 例 · 败 Y 例`

跑完告诉用户：判了几例、结论分布、**挖出几条改进点**。最后一项是这条 loop 存在的理由，
别把它埋在日志里。

## 判完之后

待修条目在控制台的用例表「判题」列点开看，按「改哪里」聚合，每条指到具体 span。
一条待修的两个关键字段是 `key`（跨轮认「同一个缺口」的稳定短名）和
`fix_where`（能直接打开的那个位置，只写一处——五处改动就是五条）。

## 定时

`/loop 30m /judge-run`，在**自己的会话**里跑，跟 `diag-run` 那个会话各是各的
（owner 2026-09-11 定：两条 loop 两个 session 分别触发）。

⚠️ **把起跑时刻错开**——比如诊断整点、判题半点。两条同时跑有两个问题：
本机多个 headless claude 进程并发会抢登录态（判题也是 claude 进程），
而且诊断还没跑完时判题捞不到东西，白起一个会话。
