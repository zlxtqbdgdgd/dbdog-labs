---
name: diag-judge
description: 给一次数据库诊断（一条 trace）判卷：结论对不对、证据撑不撑得住、改进点一条一条分六类（工具错 / skill 错 / 模型抽风 / 编排错 / 题有问题 / 判不出要人看），每条指到 span 或探针行、说清改哪里。在线判题（默认，去活系统主动查证）与离线包判题同一套判据；产出 annotations.jsonl + summary.md，回流走 diag-flywheel 的 import 脚本。触发词：判题 / 判卷 / diag-judge / 判一下这条 trace / 判这个包 / 哪些要修 / 修好了没有。
---

> 脚本位置：本插件 `skills/diag-flywheel/scripts/`，下文用 `$S` 指代它
> （`S=$(claude plugin path dbdog-agent-obs 2>/dev/null || echo ~/.claude/plugins/dbdog-agent-obs)/skills/diag-flywheel/scripts`）。
> 判题的 label 契约单源在 dbdog-web `docs/design/llmobs-diag-flywheel.md` §7.1 / §13.3；脚本母版在 dbdog-mcp `scripts/llmobs/`（镜像进本插件）。

# 诊断判题（diag-judge）

给**一次数据库诊断**判卷。一次诊断 = 一条 trace（agent 跑完一条用例留下的假设树 + 工具调用 + 结论），
判卷的产物是一条 annotation 记录，回答三个问题：**结论对不对、证据撑不撑得住、有哪些改进点**。

判题永远在用户本地 agent 跑，server 不跑模型。所以本篇**没有写工具**：你只产两个文件
（`annotations.jsonl` + `summary.md`），回流由 `$S/llmobs/judge-package-import.mjs` 做。
凭空编一个「提交判题」的工具名，或者把结论只写在回复里不落文件，都等于这次判题没发生。

**读者是谁**：你写的每一句都是给**去修的人和模型**看的，不是给你自己看的。写完把自己当成
第一次接手这个项目的同事读一遍——读不懂的、要先学词表才懂的，重写。

## 两种模式，同一套判据

**判据完全相同，差别只在材料怎么来、以及材料缺了怎么办。**

### 取数判题（默认，`loop-judge.mjs` 走的就是这条）

手上有 dbdog 工具，**该查就查**。材料来源：

| 要什么 | 怎么拿 |
|---|---|
| 整棵 trace | `get_llmobs_trace`；按 tag 筛或找 root 用 `search_llmobs_spans` |
| 题面与答案纸 | `get_llmobs_dataset_records`（答案纸 = `expected_output.expected_roots`） |
| 那一次执行的 event | `get_llmobs_experiment_event` / `list_llmobs_experiment_events` |
| 这条 trace 已有的批注 | `get_llmobs_annotations_by_content_ids` |
| 这道题之前几轮的判题 | `$S/llmobs/case-history.mjs` |
| 正向假设树 | 包里的 `forward.md`（本地渲染，MCP 取不到，只能随包走） |

判题包在这条路上只是**省一次取数**。包里没有的，自己去取——**不要把「包里没有」当成「不存在」**。

**在线是默认，离线只在没有在线条件时**（owner 2026-09-11：「要用好在线，离线是没有在线条件的时候才会搞」）。
**探针与反向链不是必需品**：有答案纸就能判对错；凡是「dbdog 有没有这条数据 / 数据对不对」的问题，**去活系统看**——任何能到的路都算：
别的工具、DDSQL、日志 / 指标 / 样本 / 计划的读口、控制台接口、直查库表、靶机，不限于把 agent 调过的那次原样再调一遍。

**在线不止于「看」，要主动查证**（owner 同日：「在线不止于只是看，要主动去查证，也不止是复调一遍，因为你知道根因呀，你是可以有更好的获取证据来支撑你的观点」）。
你手里有答案纸，就从根因**倒推该有哪些证据**，然后逐条去活系统取到手：
- 证明根因本身：库里那条报错 / 那份计划 / 那段配置真的在（直查比工具返回更硬）；
- 证明 agent 该拿到而没拿到：这份证据在库里有，agent 走的那条路却没取到——是没想到查（`model` / `skill`）还是查了工具没给（`tool`）；
- 证明 dbdog 该给而没给：库里有、工具返回空 / 错 = `tool`；库里也没有 = 采集面（也是 `tool`，落点在采集配置）或本来就没这回事。
证据强度：直查底层数据 > 换一条路取到 > 原样复调。每条改进点的 evidence 里写清走的是哪条路、拿到什么值。
只有活系统也看不出来，才记 `unsure`。离线（包判题）才依赖包里给的探针 / 反向链，没有就如实写。

### 包判题（蓝区离线，没有 MCP）

只读包里的文件，**不能回头追问**：材料不全就是结论的一部分。包目录：

```
manifest.json
skill/{SKILL.md,README.md}
cases/<event_id>/
  trace.json            原始 span（几 MB，不要通读；forward.md 已是它的结构化摘要）
  forward.md            正向假设树：agent 提了哪些假设、各拿什么证据、怎么收口
  ground-truth.md       答案纸（缺席见「没有答案纸 = 题坏了」一节）
  prior-judgments.json  这道题之前几轮的 items / checks（复验要用）
  reverse.md/.json      反向证据链（来自 record.metadata.reverse_chain）—— 条件产出
  probe.json            探针结果（由 probe.mjs 另跑写入）—— 条件产出
```

**后两样当前链路上都不产出**（用例没有 `reverse_chain`、探针没接直查腿），所以别把
「包里没有 probe.json」读成「这次探针跑了但没抓到」。

### 材料缺席怎么办 —— 两种模式给的是相反的动作

| 缺什么 | 取数判题 | 包判题 |
|---|---|---|
| `probe.json` | **去活系统核**：走任何能到的路查同一份数据（别的工具、DDSQL、直查、控制台），也可以原样重调一次做对照。核得出就照常判「工具错」或「不是问题」；活系统也看不出才判 `unsure`，并写明看了哪里、为什么看不出。**不许因为「没有探针」就直接当没有工具错，也不许因此记 `unsure`** | 抓不到两两对照的判 `unsure`，`summary` 里写明「未经探针交叉验证」 |
| `reverse.md` | 有答案纸就能倒推该有哪些证据；每条去活系统看有没有，再对照 trace 看 agent 查没查 | `skill` / `model` 两类判不准，拿不准的记 `unsure`，`summary` 写「反向链缺席」 |
| `ground-truth.md` | 两种模式相同：**题坏了**，见「没有答案纸 = 题坏了」 | 同左 |

没有反向链与探针时，「模型没想到查 X」和「查了 X 但 dbdog 没采」在 trace 里长得一模一样。
取数模式下你有办法把这两者分开——那就去分；猜出来的归因比不填更糟。

## 你要写的四个 label

| label | 取值 | 回答什么 |
|---|---|---|
| `verdict` | `correct` / `partial` / `wrong` / `unknown` | **结论对不对**——对照答案纸的根因，不是对照「说得漂不漂亮」。没有答案纸填 `unknown`（判不了，见「没有答案纸 = 题坏了」），**不许**拿「自洽」冒充 `partial` |
| `evidence` | `solid` / `weak` | **证据撑不撑得住结论**——把结论依赖的证据抽掉一条，结论还站得住吗？站不住就是 `weak`。跟对错无关：结论对但证据撑不住，就是以前说的「蒙对」 |
| `findings` | `{ items, checks }` | **改进点，一条一个**（下一节）+ 对之前几轮条目的复验 |
| `summary` | ≤ 300 字 | **总评**三句：结论对不对、一句为什么；改进点几条、最要紧的一条；判不了的写清缺什么 |

另外两个 label 不归你写：`finding_kinds`（改进点类别，import 从 `findings` 算）、`fix_marks`（修的人打的标记）。
写了会被拒。

### `evidence` 怎么判

`weak` 的形态：结论里的根因，正向假设树里没有任何假设指向它（从题面直接猜的）；指向它的那个假设名下
没有取证调用，或调用全部空 / 报错；收口写着「证实」，依据却引不到任何一次真返回了数据的调用。
结论对且证据链完整 = `solid`，哪怕路径绕。拿不准时用「抽掉这条证据，结论还站得住吗」来定。

### 没有探针结果时怎么办——按模式分

取数判题：**去活系统核**。走任何能到的路查同一份数据（别的工具、DDSQL、直查、控制台接口），
也可以原样重调一次做对照；核得出就照常判，活系统也看不出才判 `unsure` 并写明看了哪里。**不许因为「没有探针」就直接当没有工具错，也不许因此记 `unsure`**。
包判题：抓不到两两对照的判 `unsure`，`summary` 里写明「未经探针交叉验证」。

## 改进点：一条一个，先定是谁的锅（`findings.items`）

**不管结论对错都要找改进点**：结论对但走了弯路、dbdog 少给了一样东西、编排浪费了 200 次调用——都算。
但别把「本来就不必查」的记成问题：「加分」级证据 agent 没调、根因已被别的证据定死，这叫**未调无碍**，
写进 `summary` 一句即可，不进 items——否则清单里堆满「本来就不必查」，下一轮排优先级全是噪音。

每条改进点先定 `kind`，六类互斥，按「是谁的锅、怎么复现、谁来修」分。**按这个顺序问**：

| 问 | 答「是」→ kind | 判据 | 谁来修 |
|---|---|---|---|
| 1. 去活系统核（在线：走任何一条路查同一份数据；离线：探针），dbdog 是不是真的没给 / 给错？ | `tool`（工具错，**确定性**：固定代码重放必现） | dbdog 返回错值 / 有数据却返回空 / 报错 / 该有的工具或采集项没有 | dbdog 代码或采集配置 |
| 2. 重放不会错，但 skill 或提示词里写了让模型走错的话，或该教的没教？ | `skill`（skill 错，**非确定性**） | 模型照 skill 做了却做错；或 skill 根本没提这条路 | skill 正文的某一节；改完要多跑几轮才看得出 |
| 3. 工具返回对、skill 也写对了，模型自己推错 / 编造 / 没按 skill 做 / 结论没用上证据？ | `model`（模型抽风） | 证据在手却用反、引用树上不存在的假设、把「没有」读成「丢了」 | 不改代码；先记着，反复出现再往 skill 加防线（那时归 `skill`） |
| 4. 问题出在子代理派发、超时被杀、撞并发上限、工作目录模板没教约定、假设没落 tag？ | `scaffold`（编排错） | 一级假设 owner 在二级取证没回来时就交结论、root 绕过假设层拼结论、同一假设被重发 | 编排脚本 / hooks / 工作目录模板 |
| 5. 答案纸与证据矛盾、题面缺时间窗、用例不可复现？ | `case`（题有问题） | 证据链完整、结论合理，却与答案纸对不上 | 用例（题面 / 答案纸） |
| 6. 以上都拿不准：两种以上说得通、材料不够分是谁的锅？ | `unsure`（判不出，要人看） | 例如「没有数据」与「丢了数据」分不开——**在线判题时得是活系统也看不出**，不能是「没去看」 | 人来定；`suggestion` 写清要人核什么、看哪里 |

**别把「键缺席」当工具错**（2026-09-10 首例的教训）：返回体里少一个键，最常见的原因是**这条记录本来就没有那个值**
——`blocking_pids` 没有阻塞时就不出现、`wait_event_type` 未等待时显示成 `CPU`、可选字段为空时按约定省略。
采集 SQL 里出现过某个字段名，**不等于**每条返回都必须带它。要判工具错，得拿到「同一条记录在别处显示它有值」这种对照；
拿不到就判 `unsure`，写清「无法区分『没有』与『丢了』，看过哪里」（在线判题：先去活系统看，看不出再这么写）。

**工具错的三档硬证据**：① **在线核**（取数判题的默认）：去活系统看那份数据到底在不在、对不对——走别的工具、DDSQL、直查库表都行；
库里有而工具没给 = 工具错，库里本来就没有 = 不是工具的问题（可能是采集项没开，那也是 `tool`，落点在采集配置；或者本来就没这回事）。
② 探针（`probe.json`，离线）：固定代码照反向链调同样的工具、同样的参数，`outcome` 是 `empty_or_error` /
`obtained_mismatch` / `no_tool`——脚本也拿不到 = dbdog 的问题；脚本拿到了而模型没拿到 = 模型或 skill 的问题。
③ trace 内自证：同一工具、同一实例、同一时间窗，两个 span 能两两对照、且矛盾无法用「本来就没有」解释
（已确证形态：不带过滤返回的记录里带着 `wait_event_type=CPU`，加上 `@db.wait_event_type:CPU` 过滤却返回 0）。
在线判题时 ③ 只是线索，定案要走 ①；只有一个 span、无法两两对照、活系统也看不出的，才判 `unsure`。
在线核的指针写成 `{"probe":"online:<看了什么>"}`，证据段里写清查了哪条路、拿到什么值。

### 每条改进点的字段

| 字段 | 要求 |
|---|---|
| `key` | 稳定短名：小写 ascii，`<层>.<模块>.<缺什么>`，如 `server.database-schemas.not-found-echoes-request`、`skill.dbm-opengauss.sample-attribute-prefix`、`scaffold.hypothesis-template.sync-leaf`。它是跨轮次认「同一个缺口」的唯一依据 |
| `kind` | 上表六类之一 |
| `title` | 一句话，≤ 40 字，说「谁在哪出了什么事」：「schemas 工具把同一张表同时放进 tables 和 not_found」 |
| `evidence` | ≤ 3 句：**看到了什么**（带具体值与 span / 探针编号）；**本该是什么**；**为什么是问题**。例：「查 host109 的 schema 时（span 0be77ce9），表 bench.c538 同时出现在 tables 和 not_found 里。not_found 应该只放没解析到的对象。模型据此以为表不存在，绕了一圈。」 |
| `fix_where` | 能直接打开的那个位置：仓 + 文件 + 段落、skill 名 + 小节、或采集项。**只写一处**——五处改动就是五条。`tool` / `skill` / `scaffold` / `case` 必填 |
| `suggestion` | 动词开头，在那儿改什么。`tool` / `skill` / `scaffold` / `case` 必填；`unsure` 写「请核：…（看哪里）」 |
| `repro` | 可选，`tool` 类强烈建议：工具名 + 入参 + 期望 vs 实际，让修的人一条命令就能复现 |
| `pointers` | 至少一项：`{"span_id":"…"}`（正向那一步）或 `{"probe":"E3"}`（反向链 / 探针的第几条） |

两条硬规则（违反就等于没判，import 会整包拒写）：

1. **能修的必须说「改哪里」**，而且一条只说一处。写「改进工具契约」「优化 prompt」这种没有落点的话，等于没写。
2. **每条都必须指到具体一行。** 指不到就说明你还没找到证据：这一条不写，在 `summary` 里写明「归因不明，缺什么」——那也是有效结论。

同一个根因的多处表现合并成一条（一个 key）；不同落点的才分开。

### 语言纪律（写给要去修的人，不是写给判官自己）

- **不用内部代号**：不写 P1 / H3b / E2 这种只有你知道的编号，改说「探针第 1 条」「假设 H3b（看等待事件那条）」；指针放 `pointers`，正文里用人话。
- **不用行话**：「投影层物化」→「界面上显示成 CPU」；「非单调」→「窗口拉大反而查到更少」。
- **数字带对照**：「返回 0 条」不够，要「返回 0 条，去掉过滤返回 2 条」。
- **一句一个意思**，不用分号串三件事。
- `summary` 三句以内；细节写进各条改进点，不要把改进点又在 summary 里复述一遍。

## 之前几轮提过的改进点：逐条复验（`findings.checks`）

一道题会跑很多轮。**修没修好不由人标，也不由修的人说了算，由后续轮次的实际表现说了算**——所以判任何一轮，
都要先拿到这道题之前几轮提过的条目，把**还没关的**逐条复验一遍：

| `status` | 什么时候用 | `pointers` |
|---|---|---|
| `fixed` | 这一轮走到了那条路，缺口不再出现（该有的字段有了、该返回的返回了、那条 skill 规则被照做了） | **必填**：指到证明它不再出现的那一步 |
| `still_open` | 这一轮又撞上了 | **必填**：指到又撞上的那一步 |
| `not_exercised` | 这一轮根本没走到那条路（没调那个工具、没进那个分支） | 可空；不算数，那一条维持原状 |

每条 check 带 `key`、`status`、`kind`（照抄原条目的）、`note`（这一轮看到的新情况，一句）。

- **哪些算「还没关」**：一个 key 最后一次**有效复验**（`fixed` / `still_open`）不是 `fixed`，或者 `fixed` 之后又被当成新条目提出来——都算没关。
  没关的每一条都要有一个 check，一条都不许漏。
- **修的人打了 `claimed_fixed` 标记的**（材料里的 `fix_marks`），这一轮要**特意走到那条路去验**：验得出就写 `fixed` / `still_open`，
  走不到写 `not_exercised`——标记是声明，复验才是判决。
- **又撞上的只写 `still_open`**，不要在 `items` 里再提一条同 key 的；换个 key 把老缺口当新的提，更不行——那样就永远数不清它修没修。

材料从哪来：包判题读 `cases/<event_id>/prior-judgments.json`（这道题之前几轮的 `items` / `checks` / `fix_marks`，旧的在前；
`judged:false` 的那几轮没判过）；取数判题跑

```sh
node $S/llmobs/case-history.mjs --record <record_id> --before <这一轮的 trace_id>
```

两者同一个形状。空数组 = 这道题之前没判过，`checks` 省略。

## 没有答案纸 = 题坏了

**每道用例都必须有答案纸。** `expected_output.expected_roots` 里必须有一条「根因」，
且根因取自 issue 正文或它对应的**已合入 PR**（PR 正文的「根因分析」段），并在答案纸里
标明出处、用 `issue#N` / `PR#N` 前缀区分——同一个数字在两边往往是完全不同的两件事。
两处都取不到根因的题不该进用例集。这是建用例那一步的硬约束，不是判题时才补的。

所以判题时遇到没有答案纸的题，**不是换一套口径去判，而是判定这道题坏了**：

- `verdict` 填 `unknown`（判不了）。没有答案纸就没有「对」这个判断，填了就是编。
- `evidence` 照判（判据换成「结论有没有被自己的证据链撑住」）；**工具错照找**——那判的是 dbdog，跟有没有标准答案无关，这道题的价值也只剩这一半。
- `findings.items` **必记一条 `case` 类**：`key` 写 `case.answer-key.missing`，`title`「这道题没有答案纸」，
  `fix_where` 指到用例集里这条 record，`suggestion`「回建用例那一步补根因（取自 issue 正文或已合入 PR），补不了就删题」，`pointers` 指 root span。
- `summary` **第一句**写明：`⚠ 无答案纸，本题不可判结论——请回建用例那一步补根因（取自 issue 或其 PR）或删题`。

这样这类题会在判题结果里**显形**（结论「判不了」+ 一条「题有问题」），下一轮一眼能数出「有几道题没根因」；
用一套「自洽性口径」把它悄悄消化掉，它就会在页面上混成正常分数，再也没人去修。

**答案纸里的现场事实不算「矛盾」。** 答案纸讲的是机制（哪段代码、什么条件下触发）；
里面若残留另一次现场的主机名、build 串、EXPLAIN 数值，与本次现场对不上**不算**「题有问题」
——机制对不上才算。

### 结论自洽性：对上了答案纸还要过的第二关

结论与答案纸的根因一致，`verdict` 照判 `correct`——但它还得被自己引的证据撑住，那是 `evidence` 这一轴的事：

- 主结论所靠的那条证据链自相矛盾（同一指标两种口径、收口记录与结论相反）→ `evidence` 判 `weak`，并记一条 `model` 类改进点指到那两个 span；
- 只是旁支不自洽（某个对照失败没披露、某条过滤描述不准）→ `evidence` 仍可 `solid`，
  但**每处次级不自洽都记一条 `model` 类改进点并指到 span**（2026-09-10 试跑定），不要只在 `summary` 里带一句就过。

## 产物

**`annotations.jsonl`**：每例一行，一行一个完整 JSON 对象（不换行、不带注释、不加尾逗号）。

```json
{"trace_id":"7186293b…","labels":{"verdict":"partial","evidence":"solid","findings":{"items":[{"key":"agent.opengauss-checkpoint.not-collected","kind":"tool","title":"openGauss 的检查点指标没有采","evidence":"反向链第 3 条要查检查点次数，探针照调 get_dbdog_metric 返回空（探针第 3 条）。这台实例的 checkpoint 采集项没开，所以整个 org 都没有这组指标。模型因此走不到检查点风暴这条路。","fix_where":"dbdog-agent 的 opengauss 集成配置（integrations 的 checkpoint 采集项）","suggestion":"把 checkpoint 相关指标纳入默认采集","repro":"get_dbdog_metric metric=opengauss.bgwriter.checkpoints_timed 近 7 天：期望有点位，实际空","pointers":[{"probe":"E3"}]},{"key":"skill.dbm-opengauss.metric-reference-checkpoint","kind":"skill","title":"dbm-opengauss skill 没告诉模型该查检查点指标","evidence":"正向假设树里没有任何假设指向检查点（span a1b2c3d4 是最接近的一步，查的是写 I/O）。skill 的指标参考小节没有检查点这一行。模型不知道有这条路。","fix_where":"dbdog/dbm-opengauss 的指标参考小节","suggestion":"补一行检查点指标，说明写 I/O 抬头时先看它","pointers":[{"span_id":"a1b2c3d4"}]}],"checks":[{"key":"server.samples.wait-event-filter","status":"fixed","kind":"tool","pointers":[{"span_id":"9f0e1d2c"}],"note":"这一轮加 @db.wait_event_type:CPU 过滤返回 16 条，与不带过滤一致"}]},"summary":"根因定到了写 I/O 饱和，但没走到检查点风暴，所以判部分对。改进点两条：检查点指标没采（工具错），skill 也没教这条路。上一轮的等待事件过滤 bug 这一轮验证修好了。"}}
```

`trace_id` 必须与包里 / 现取到的那条对得上——它是回流时找 interaction 的唯一键。

**`summary.md`**：本轮总账，一段话到一页。要有的东西：判了几例、结论与证据的分布（只有一例时免写分布）、
改进点按 `key` 聚合的清单（同一个 key 在多例里撞到就合并、标命中例数与类别）、本轮复验几条 `fixed` / `still_open` / `not_exercised`、
这一轮最该先修的三条、以及你判不动的地方（缺哪种材料）。这段话会挂到 run metadata 上，
是下一轮对比页的「本轮总账」。语言纪律同上。

**改判 = 覆盖**（同一条 trace 的同一个 label 只有一个当前值，无历史）。所以重判就重跑一次
import，不要在 `annotations.jsonl` 里追加第二行同 `trace_id` 的记录。

## 回流

```sh
node $S/llmobs/judge-package-import.mjs --package <包目录> --annotator <判题模型名>
```

`--annotator` 必填（导出时带过 `--judge-model` 的包可省）：同一道题两轮结论不一样，得分得清是 agent 变了还是判题换了——
不记判题模型，import 直接拒。

它按 `manifest.json` 里记的 label id 写 annotation（**不重发 label schema**——不带原 id 重发
会把该队列已有的批注级联删光），从 `findings` 算出 `finding_kinds` 一起写，再把 `summary.md` 打到 run metadata，
把 `reverse-chain-revisions/` 里的修订挂回用例。分数不用你写：server 收到 annotation 后
自动投影成 experiment metric 与 root span 的 `evaluation.*` tag，判题方只交一次。

投影完之后 `search_llmobs_spans` 就能按 `tags` 筛了，例如 `{"evaluation.evidence":"weak"}` 捞出所有证据撑不住的 trace，
`{"evaluation.finding_kinds":"tool"}` 只能等值匹配——有多类时是逗号串，要筛「含 tool」拉回来自己判。

## 修好了怎么关（不归你，但你要知道）

修的人改完跑 `$S/llmobs/fix-mark.mjs --trace <挖出它的 trace> --key <key> --status claimed_fixed --note "改了什么" --by <谁>`
打标记；改不动的打 `needs_human`。**关不关看复验**：重跑挖出它的那几道题、判那一轮，复验是 `fixed` 这一条才算关。

## 用户在会话里怎么说，你怎么接

- 「判一下这条 trace `<trace_id>`」→ 取数判题：`get_llmobs_trace` 拿整棵树，从 root 的
  `dataset_record_id` / experiment event 找到用例，`get_llmobs_dataset_records` 拿答案纸与
  `metadata.reverse_chain`，有 `probe.json` 就一起读；跑 `case-history.mjs --record <record_id> --before <trace_id>`
  拿这道题之前几轮的改进点，逐条复验还没关的；判完把 `annotations.jsonl` 写到当前目录，
  贴结论 / 证据 / 改进点清单（每条带类别），然后告诉用户跑 import 的那行命令（带 `--annotator`）。
- 「判这个包 `<目录>`」→ 包判题：先读 `manifest.json` 点清有几例、label schema 是哪一版；
  逐例判，一例一行追加进包根的 `annotations.jsonl`；最后写 `summary.md`。**不要**为了补材料
  去调工具——包判题的前提就是不能追问，缺什么如实写进 `summary`。
- 「这一轮哪些是 dbdog 要修的」→ 判完之后从 `summary.md` 的清单答：`tool` / `skill` / `scaffold` 三类是 dbdog 侧能动手的，
  每条带 `key`、`fix_where` 和命中例数；没判过的轮次先判，不要凭 trace 数量猜。
- 「哪些要人看」→ `unsure` 那几条，每条把「请核：…」念给用户。
- 「X 修好了没有」→ 不由你说了算，也不由修的人说了算：重跑挖出它的那几道题，判那一轮，看 X 的复验是不是 `fixed`。
- 「重判一下第 3 例」→ 改那一行、重跑 import，覆盖生效；别追加一行。
- 材料缺了就说清楚缺哪份：没有 `forward.md` 说明那条 trace 没按假设约定书写
  （`clients/diag-workdir-template/HYPOTHESIS.md`），只有调用序列可看，`skill` 与 `model` 两类这轮判不准；
  没有 `probe.json`：在线判题就去活系统核（不需要探针）；离线才只能靠 trace 内两两对照抓，抓不到的判 `unsure`。
