---
name: diag-judge
description: 给一次数据库诊断（一条 trace）判卷：结论对不对（多根因按集合算命中，verdict 由集合推导）、证据撑不撑得住、改进点一条一条分六类（工具错 / skill 错 / 模型抽风 / 题有问题 / 复现环境侧 / 判不出要人看），每条再标落在哪一层、是缺失还是写错，每类绑死一个下一步动作和一种验法，每条指到能核得到的 span 或探针行、说清改哪里。在线判题（默认，去活系统主动查证）与离线包判题同一套判据；产出 annotations.jsonl + summary.md，回流走 diag-flywheel 的 import 脚本。触发词：判题 / 判卷 / diag-judge / 判一下这条 trace / 判这个包 / 哪些要修 / 修好了没有。
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
| `findings` | `{ items, checks, roots }` | **改进点，一条一个**（下一节）+ 对之前几轮条目的复验 + 根因命中集合（有答案纸时必填，见「多根因」） |
| `summary` | ≤ 300 字 | **总评**三句：结论对不对、一句为什么；改进点几条、最要紧的一条；判不了的写清缺什么。**硬上限 600 字符**，超了整包拒写 |

**四个一个都不能少。** 只写 `summary` 的批注也能导进去（校验器只查「写了的对不对」），
但页面上那一行的结论与证据就永远是空的，而下一轮的历史里它又算「判过了」——再没人回头补。

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
但别把「本来就不必查」的记成问题：**根因已经被别的证据定死了，这一条查不查都不改变结论**——这叫**未调无碍**，
写进 `summary` 一句即可，不进 items。判法就一句：把这条没调的证据补上，结论会变吗？不会就是未调无碍。
（别用「加分级证据」这种说法——那是反向证据链里的分档，在线判题多半没有反向链，判官无从对照。）
否则清单里会堆满「本来就不必查」，下一轮排优先级全是噪音。

每条改进点要填**三个互不替代的属性**：谁去干（`kind`）、落在哪一层（`layer`）、是缺失还是写错（`qualifier`）。
一条改进点提出来，读的人要能不假思索地走下去（owner 2026-09-11：「我们的错一定是能转换为下一步动作的，
不能提了不知道怎么往下走」）。

### ① `kind`：下一步**谁**去干，六类互斥

**分类的唯一标准是「下一步谁去干什么、怎么验」。按这个顺序问**：

| 问 | 答「是」→ kind | 判据 | 下一步动作 | 怎么验 |
|---|---|---|---|---|
| 1. 去活系统核（在线：走任何一条路查同一份数据；离线：探针），固定代码重放同一调用会不会一样错？ | `tool`（工具错，**确定性**） | dbdog 返回错值 / 有数据却返回空 / 报错 / 该有的工具或采集项没有；也包括 hooks、跑批脚本这类**代码**的错（停不掉子任务、该打点的没打），以及判题 / 诊断编排自己的运行时问题（会话被超时杀掉、批量调用打爆预算） | 在 `fix_where` 指的仓 + 文件改代码或配置，出 PR；`repro` **必填** | 重放必须变对；下一轮复验一次 `fixed` 即关 |
| 2. 重放不会错，但**给模型的话**写错了、或该写的没写？（skill 正文、工作目录模板 `HYPOTHESIS.md`、派单提示词都算） | `skill`（skill 错，**非确定性**） | 模型照着做了却做错；或那条路 / 那条规矩根本没写——子代理派发规则、假设怎么记、谁能收口，都是「给模型的话」 | 在 `fix_where` 指的那一节改一段话；`suggestion` **必须写出要加或要改的原句**（用「」引起来） | 非确定性：重跑至少 2 轮不再犯才关 |
| 3. 工具返回对、规矩也写了，模型自己推错 / 编造 / 没照做 / 结论没用上证据？ | `model`（模型抽风） | 证据在手却用反、引用树上不存在的假设、把「没有」读成「丢了」。**必须给反证**：`rule_ref` 写出规矩写在哪个 skill 的哪一节 | 不改代码，先记着；**这道题之前已经有过一次同 key 的 `model`，这一轮就直接提一条 `skill`**（带原句），不要等页面提示 | 计次 |
| 4. 答案纸与证据矛盾、题面缺时间窗、用例本身不可复现？ | `case`（题有问题） | 证据链完整、结论合理，却与答案纸**讲的机制**对不上。**要判这一类，必须去读答案纸标的出处**（issue 正文或那条已合入 PR）并在 `evidence` 里引出原文与矛盾点；引不出来就不是 `case`，是 `wrong` 或 `unsure` | 回**建用例**那一步改题面 / 答案纸，`fix_where` 指到那条 record（判官自己不改用例） | 下一轮按新答案纸判 |
| 5. 题没问题、dbdog 也没问题，但**这次复现的现场不对**？ | `env`（复现 / 环境侧） | 窗口里现象根本没出来、靶机被重装或换了版本、时间窗与现场对不上——诊断做得再对也定位不到 | 回**复现**那一侧重跑（那是另一个系统的活，我们只收回执），`fix_where` 指到这条复现回执 | 下一次复现的窗口里能看到现象 |
| 6. 以上都拿不准：两种以上说得通、材料不够分是谁的锅？ | `unsure`（判不出，要人看） | 例如「没有数据」与「丢了数据」分不开。**在线判题要判 `unsure`，先走完三条路**：① 直查库表 ② 换一个工具或另一个口 ③ 控制台 / 日志 / 指标——三条都看不出才算数，`evidence` 里写明各走到哪。`suspected_kind` 必填 | 人按 `suggestion` 写的地方去核，定成上面之一；`summary` 里要点名「本例有 N 条要人核」，否则没人知道该来看 | 人定后重跑一次 import 覆盖，不是追加一行 |

**`env` 是 2026-09-11 补的**：在此之前，「这次复现根本没出现象」无处可放，只能塞 `case`（冤枉了题）
或 `unsure`（假装判不出）——两种都会让下一轮读不懂这条到底该谁去动。

**`model` 是「前两问都答否」的剩余类，也是最容易归错的一类**，所以对它的要求反而最硬：
外部基准（Who&When Pro，12,326 条轨迹）实测模型判错误类别的 macro-F1 最高只有 22.2%、定位决定性错误步约 14%。
给不出 `rule_ref` 与那一步的指针，就降级成 `unsure`——**空口断言的 `model` 比不提更糟**，
因为它不改代码、只计次，等于把一个真问题静默沉底。

**「编排错」这一类没有了**（2026-09-11 撤掉）：它按话题分，不按下一步分，一条提出来分不清该改代码还是改话。
以前归它的：hooks / 跑批脚本的代码错 → `tool`；工作目录模板 / 派单提示词写错或没写 → `skill`。

### ② `layer`：`tool` 类落在哪一层（必填）

同是「工具错」，四个落点是四个仓、四个人，连怎么验都不一样：

| layer | 什么样的问题 | 怎么验 |
|---|---|---|
| `server` | MCP 工具的查询 / 返回契约错（返回空、字段拼错、not_found 乱放） | 重放同一调用，返回必须变对 |
| `agent` | 该采的没采、采集项没开、集成配置不对 | 改配置 + 重装 + **等一个采集周期**，再查该有的点位 |
| `hooks` | 采集 span 的钩子漏采、错采、超预算 | 重放一次会话，span 必须齐 |
| `scripts` | 跑批 / 编排脚本的错（停不掉子任务、领了活不放回、会话超时被杀） | 重跑那一条命令 |

**从现象跳到落点**，常见的几条（写 `fix_where` 时对着找，别只写到仓级——写到仓级，修的人还得再找一遍）：

| 看到的现象 | 多半落在 | 去哪儿看 |
|---|---|---|
| 工具返回空 / 返回错值 / 字段拼错 / not_found 乱放 | `server` | dbdog-mcp 的 `src/tools/<工具名>` 与它拼的查询 |
| 指标 / 样本 / 计划根本没有点位，库里也查不到 | `agent` | dbdog-agent 的集成配置（那个引擎的采集项开没开） |
| 轨迹里少了本该有的 span、假设没记上、会话结尾丢一段 | `hooks` | dbdog-labs 的 `claude-code-hooks/` |
| 领了活不放回、会话被超时杀掉、子任务停不掉、批量调用打爆预算 | `scripts` | `skills/diag-flywheel/scripts/llmobs/` 里那条 loop |
| 模型没想到查某样东西 | 先查 skill 正文有没有写；没写是 `skill`·`missing` | 那个引擎的 dbm-* skill |

---

### ③ `qualifier`：缺失 / 写错 / 多余（`tool`、`skill` 必填）

这一维来自 ODC（Orthogonal Defect Classification，IBM）：**「有没有」和「对不对」是两回事，
不该挤进同一个类别里**。

| qualifier | `tool` 的样子 | `skill` 的样子 |
|---|---|---|
| `missing` | dbdog 根本没有这个工具 / 这项没采 —— 下一步是**排能力**，不是修 bug | 那条路、那条规矩根本没写 |
| `incorrect` | 有，但返回错值 / 空 / 报错 —— 下一步是**修 bug** | 写了，但写错了、或写得含糊到模型照做也会做错 |
| `extraneous` | 返回了不该返回的东西（把解析到的对象塞进 not_found） | 写了多余的规矩，把模型往沟里带 |

**「写了但写得含糊」算 `skill` + `incorrect`，不算 `model`。** 含糊到什么程度算没写清，是语言判断，
判官在这里最容易摇摆；规则定死一边：**含糊即算写规矩的人的锅**。这和「没禁止就是模板没写」是同一条精神。

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
| `key` | 稳定短名：小写 ascii，`<层>.<模块>.<缺什么>`，如 `server.database-schemas.not-found-echoes-request`、`skill.dbm-opengauss.sample-attribute-prefix`、`template.dispatch.background-leaf-results-lost`、`hooks.taskstop.owner-check-rejects-dispatcher`。它是跨轮次认「同一个缺口」的唯一依据 |
| `kind` | 上表六类之一 |
| `layer` | `tool` 类必填：`server` / `agent` / `hooks` / `scripts`（见 ② 那张表） |
| `qualifier` | `tool`、`skill` 必填：`missing` / `incorrect` / `extraneous`（见 ③ 那张表） |
| `rule_ref` | `model` 类必填：规矩写在哪个 skill / 模板的**哪一节**。查不到那一节 = 这是 `skill` 缺规矩，不是模型抽风 |
| `suspected_kind` | `unsure` 类必填：疑似是上面哪一类。弃判不是一种缺陷，它是「还没定」——记下疑似类别，这一条才留得在对应的漏斗里 |
| `title` | 一句话，≤ 40 字，说「谁在哪出了什么事」：「schemas 工具把同一张表同时放进 tables 和 not_found」 |
| `evidence` | ≤ 3 句：**看到了什么**（带具体值与 span / 探针编号）；**本该是什么**；**为什么是问题**。例：「查 host109 的 schema 时（span 0be77ce9），表 bench.c538 同时出现在 tables 和 not_found 里。not_found 应该只放没解析到的对象。模型据此以为表不存在，绕了一圈。」 |
| `fix_where` | 能直接打开的那个位置：仓 + 文件 + 段落、skill 名 + 小节、或采集项。**只写一处**——五处改动就是五条。`tool` / `skill` / `case` 必填 |
| `suggestion` | 动词开头，在那儿改什么。`tool` / `skill` / `case` 必填；`skill` 类必须含要加或要改的原句（「」引起来）；`unsure` 写「请核：…（看哪里）」 |
| `repro` | **`tool` 类必填**：工具名 + 入参 + 期望 vs 实际，**一条命令**能重放。关掉 `tool` 的判据就是「重放变对」——没有可重放的东西，这一条永远关不掉。别写成要搭半小时环境的步骤，那种没人会跑 |
| `pointers` | 至少一项：`{"span_id":"…"}`（正向那一步）或 `{"probe":"E3"}` / `{"probe":"online:<看了什么>"}`。**`span_id` 会被回流脚本拿去跟 `trace.json` 对**：轨迹里没有这条 span，或者你写的前缀配到两条以上，整包拒写 |

三条硬规则（违反就等于没判，import 会整包拒写）：

1. **能修的必须说「改哪里」**，而且一条只说一处。写「改进工具契约」「优化 prompt」这种没有落点的话，等于没写。
2. **每条都必须指到具体一行。** 指不到就说明你还没找到证据：这一条不写，在 `summary` 里写明「归因不明，缺什么」——那也是有效结论。
3. **指针要真指得到。** `span_id` 写全或写前 8 位都行，但它必须在这条 trace 里；配到两条以上等于没指。
   这一条是机器核的：外部基准（TRAIL）实测，长轨迹下模型的错误定位准确率极低、有的模型连完整轨迹都读不下——
   只校验形状不校验存在，等于在鼓励编一个 span id 填上。

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

- **哪些算「还没关」，别自己手算**：规则是「一个 key 最后一次有效复验（`fixed` / `still_open`）不是 `fixed`，
  或者 `fixed` 之后又被当成新条目提出来」，`skill` 类非确定性要**连续两轮** `fixed` 才关，`model` 类不复验只计次。
  这套状态机由脚本跑——**开判第一件事就是拿这份清单**：

  ```sh
  node $S/llmobs/case-history.mjs --record <record_id> --before <这一轮的 trace_id> --open
  ```

  出的是 `[{key, kind, last_status, since, fix_mark}]`，**清单上每一条都要有一个 check，一条都不许漏**。
  过去这一步要判官自己在几十条历史里推，漏一条没人拦得住——而漏验和「这一条真没修好」在页面上长得一模一样。
- **修的人打了 `claimed_fixed` 标记的**（材料里的 `fix_marks`），这一轮要**特意走到那条路去验**：验得出就写 `fixed` / `still_open`，
  走不到写 `not_exercised`——标记是声明，复验才是判决。
- **又撞上的只写 `still_open`**，不要在 `items` 里再提一条同 key 的；换个 key 把老缺口当新的提，更不行——那样就永远数不清它修没修。

材料从哪来：包判题读 `cases/<event_id>/prior-judgments.json`（这道题之前几轮的 `items` / `checks` / `fix_marks`，旧的在前；
`judged:false` 的那几轮没判过）；取数判题跑

```sh
node $S/llmobs/case-history.mjs --record <record_id> --before <这一轮的 trace_id>
```

两者同一个形状。空数组 = 这道题之前没判过，`checks` 省略。

## 多根因：按集合记，`verdict` 是推出来的

**答案纸里的根因可以不止一条**，而且根因假设**不互斥**——多根因的题可以多个同时证实
（owner 2026-09-06 定）。所以判结论不是「对/不对」一句话，而是先划分集合：

```json
"roots": { "matched": [1, 3], "missed": [2] }
```

编号 = 答案纸里 `expected_roots` 的**出现顺序**（`ground-truth.md` 的「期望根因」是按序列的）。
每一条都要表态，不重不漏；然后 `verdict` **按集合推导**，不是另填一个感觉：

| 集合 | `verdict` |
|---|---|
| 找齐（`missed` 空） | `correct` |
| 找到一部分 | `partial` |
| 一条没找到 | `wrong` |

**回流会核这件事**：`verdict` 与集合对不上就整包拒写——命中一条根因却判 `correct`，
是这条 loop 最贵的错（分数是它的主产出之一，而且会一路带偏跨轮对比）。

记集合、而不是只留一个三值，还有第二个好处：**以后口径再改（比如改成按权重折算），历史轮次能重算，不用重判**。
外部的根因定位评测（RCAEval 这类）用 precision / recall / AC@k 也是同一个理由：先留住命中集合，再谈怎么折算。

## 没有答案纸 = 题坏了

**每道用例都必须有答案纸。** `expected_output.expected_roots` 里必须至少有一条「根因」，
且根因取自 issue 正文或它对应的**已合入 PR**（PR 正文的「根因分析」段），并在答案纸里
标明出处、用 `issue#N` / `PR#N` 前缀区分——同一个数字在两边往往是完全不同的两件事。
两处都取不到根因的题不该进用例集。这是建用例那一步的硬约束，不是判题时才补的。

所以判题时遇到没有答案纸的题，**不是换一套口径去判，而是判定这道题坏了**：

- `verdict` 填 `unknown`（判不了），并且**不写 `findings.roots`**（没有答案纸就没有集合可划）。
  没有答案纸就没有「对」这个判断，填了就是编——回流会拒。
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

## 已知的设计取舍：这些不是缺陷，别每轮再提一遍

有些「看起来像 bug」的东西是定过的取舍。判官手上没有这份名单，就会每一轮把同一条当新发现提上来，
把清单撑成噪音——而修的人看到第三次同样的条目，就不再看这张清单了（Google 的 Tricorder 量过：
误报率一过 ~10%，整个分析器会被开发者整体忽略）。

| 已定的取舍 | 谁定的 | 判官该怎么写 |
|---|---|---|
| dbdog-agent 自己发的慢 SQL 两边都不采 | owner 2026-09-08：这是设计，别给排除规则加豁免 | 不记 items；真要提就提 `case`（题面不该指望看到它） |
| 「键缺席」不等于工具丢数据 | 2026-09-10 首例的教训（下一节） | 拿不到对照就 `unsure`，别记 `tool` |
| 停机跨多次轮转丢中间文件 | owner 2026-09-08 定不修 | 不记 |

**这张表要随取舍更新**；遇到拿不准是不是取舍的，按 `unsure` 提并在 `suggestion` 里写「请核：这是不是已定的取舍」。

## 你只判不改；哪些你自己闭合，哪些升 owner

判题会话挂着 dbdog 工具、也有 shell——**但你的交付物只有 `annotations.jsonl` 和 `summary.md`**。
不改用例、不改 skill 正文、不改 dbdog 的代码、不在靶机上做任何写操作。看见该改的，写进条目里。

哪些判断你自己就能闭合、哪些必须留给人，分界线是**「事实 / 口径」**：

| 你自己闭合（不许退成 `unsure`） | 为什么 |
|---|---|
| 这份数据在不在、工具返回对不对 | 你有工具、能直查——这是事实对照，不是意见 |
| 那条规矩写没写、写没写清 | 纯文本，去读那一节就有答案 |
| 证据撑不撑得住结论（`evidence`） | 对手上材料的内部推理，不需要外部信息 |
| 这一轮有没有走到那条路（`checks`） | 轨迹是现成的 |
| 根因命中集合与由它推出的 `verdict` | 有答案纸就是机械对照 |

| 必须留给人（升 owner） | 为什么 |
|---|---|
| 「答案纸本身错了」 | 你能指出矛盾，但改用例集会让**所有历史轮次的分数失去可比性**——这是权威判断 |
| 「dbdog 该不该有这个能力」 | 路线图问题，不是事实问题；参见上面那张取舍表 |
| 判题口径本身要不要改 | 改口径影响跨轮可比性 |
| 三条路都看不出的 `unsure` | 真·判不出：写清看过哪里，交给人 |

## 交卷前对一遍（违反任何一条，回流整包拒写，这一例几十分钟白跑）

- [ ] 四个 label 都写了：`verdict` / `evidence` / `findings` / `summary`
- [ ] 有答案纸：`findings.roots` 把每条根因都划进 `matched` 或 `missed`，且 `verdict` 与集合对得上
- [ ] 没答案纸：`verdict` 是 `unknown`、没有 `roots`、并且记了一条 `case.answer-key.missing`
- [ ] 每条改进点都有 `title` / `evidence` / `pointers`，且 `span_id` 在这条 trace 里真找得到
- [ ] `tool` 类：`layer` + `qualifier` + `repro` + `fix_where` + `suggestion` 都在
- [ ] `skill` 类：`qualifier` 在，`suggestion` 里用「」引出了要加或要改的原句
- [ ] `model` 类：`rule_ref` 指到具体哪一节
- [ ] `unsure` 类：`suspected_kind` + 「请核：…（看哪里）」，且三条取证路都走过了
- [ ] `case-history --open` 清单上的每一条都有对应的 check，一条不漏
- [ ] 没写 `finding_kinds` / `fix_marks`（那两个不归你）
- [ ] `summary` 在 600 字符内

## 产物

**`annotations.jsonl`**：每例一行，一行一个完整 JSON 对象（不换行、不带注释、不加尾逗号）。

```json
{"trace_id":"7186293b…","labels":{"verdict":"partial","evidence":"solid","findings":{"items":[{"key":"agent.opengauss-checkpoint.not-collected","kind":"tool","layer":"agent","qualifier":"missing","title":"openGauss 的检查点指标没有采","evidence":"直查这台实例的指标库，checkpoints_timed 一个点位都没有；同版本的另一台有。采集项没开，所以整个 org 都没有这组指标。模型因此走不到检查点风暴这条路。","fix_where":"dbdog-agent 的 opengauss 集成配置（integrations 的 checkpoint 采集项）","suggestion":"把 checkpoint 相关指标纳入默认采集","repro":"get_dbdog_metric metric=opengauss.bgwriter.checkpoints_timed 近 7 天：期望有点位，实际空","pointers":[{"probe":"online:直查指标库 + 同版本另一台对照"}]},{"key":"skill.dbm-opengauss.metric-reference-checkpoint","kind":"skill","qualifier":"missing","title":"dbm-opengauss skill 没告诉模型该查检查点指标","evidence":"正向假设树里没有任何假设指向检查点（span a1b2c3d4 是最接近的一步，查的是写 I/O）。skill 的指标参考小节没有检查点这一行。模型不知道有这条路。","fix_where":"dbdog/dbm-opengauss 的指标参考小节","suggestion":"在指标参考小节补一行：「写 I/O 抬头时先看 checkpoints_timed 与 checkpoints_req」","pointers":[{"span_id":"a1b2c3d4"}]}],"checks":[{"key":"server.samples.wait-event-filter","status":"fixed","kind":"tool","pointers":[{"span_id":"9f0e1d2c"}],"note":"这一轮加 @db.wait_event_type:CPU 过滤返回 16 条，与不带过滤一致"}],"roots":{"matched":[1],"missed":[2]}},"summary":"两条根因命中一条（写 I/O 饱和），没走到检查点风暴，按集合口径判部分对。改进点两条：检查点指标没采（工具错·采集层·缺失），skill 也没教这条路。上一轮的等待事件过滤 bug 这一轮验证修好了。"}}
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
  `metadata.reverse_chain`，有 `probe.json` 就一起读；跑 `case-history.mjs --record <record_id> --before <trace_id> --open`
  拿这道题**还没关的条目清单**，逐条复验（一条都不许漏）；判完把 `annotations.jsonl` 写到当前目录，
  贴结论 / 证据 / 改进点清单（每条带类别），然后告诉用户跑 import 的那行命令（带 `--annotator`）。
- 「判这个包 `<目录>`」→ 包判题：先读 `manifest.json` 点清有几例、label schema 是哪一版；
  逐例判，一例一行追加进包根的 `annotations.jsonl`；最后写 `summary.md`。**不要**为了补材料
  去调工具——包判题的前提就是不能追问，缺什么如实写进 `summary`。
- 「这一轮哪些是 dbdog 要修的」→ 判完之后从 `summary.md` 的清单答：`tool` / `skill` 两类是 dbdog 侧能动手的，
  每条带 `key`、`fix_where` 和命中例数；没判过的轮次先判，不要凭 trace 数量猜。
- 「哪些要人看」→ `unsure` 那几条，每条把「请核：…」念给用户。
- 「X 修好了没有」→ 不由你说了算，也不由修的人说了算：重跑挖出它的那几道题，判那一轮，看 X 的复验是不是 `fixed`。
- 「重判一下第 3 例」→ 改那一行、重跑 import，覆盖生效；别追加一行。
- 材料缺了就说清楚缺哪份：没有 `forward.md` 说明那条 trace 没按假设约定书写
  （`clients/diag-workdir-template/HYPOTHESIS.md`），只有调用序列可看，`skill` 与 `model` 两类这轮判不准；
  没有 `probe.json`：在线判题就去活系统核（不需要探针）；离线才只能靠 trace 内两两对照抓，抓不到的判 `unsure`。

## 这一版口径的外部依据（2026-09-11 改版时对过的工作）

改版不是凭手感排的，几处硬要求各有出处；下次再想放松某一条时，先看这里为什么定成这样：

| 这份 rubric 里的规矩 | 出处 | 那边的结论 |
|---|---|---|
| `kind` × `layer` × `qualifier` 三维分开，不靠加类别 | ODC（Orthogonal Defect Classification，IBM Chillarege） | 缺陷分类要正交；**缺失 / 写错 / 多余**是与类别独立的一维 |
| `model` 类必须给反证，否则降 `unsure` | Who&When Pro（12,326 条轨迹的失败归因基准） | 模型判错误类别 macro-F1 ≤ 22.2%、定位决定性步 ≈ 14%——最容易归错的一类要最硬的证据 |
| `span_id` 必须在轨迹里真找得到（机器核） | TRAIL（148 条人工标注轨迹、841 个错误） | 最好的模型联合定位只有 11%，部分模型连完整轨迹都读不下——只校验形状等于鼓励编 |
| `tool` 类 `repro` 必填，且要一条命令能跑 | Bettenburg 等对 466 名开发者的调查 | 复现步骤是开发者最想要的字段；复杂到要一小时搭建的复现没人会跑 |
| 弃判（`unsure`）单列、不混进产量 | Autorubric 的 `CANNOT_ASSESS`；rubric 判题的一致性测量惯例 | 弃判要与一致率分开报，否则「不敢判」会被读成「判得像」 |
| 已定取舍要有名单，无效条目率要量 | Tricorder（Google 的静态分析平台） | 误报率一过 ~10%，开发者就整体不看那个分析器了 |
| 多根因按集合记，`verdict` 推导 | 根因定位评测（RCAEval 这类）的 precision / recall / AC@k | 先留住命中集合，再谈怎么折算——口径改了还能重算 |
| 先量判官一致性、再改分类定义 | MAST（14 类多智能体失败分类，人工双标 κ=0.88） | 类别定义好不好，看两个判官判得像不像；κ 低的那一类就是定义最糊的那一类 |

量一致性的工具在 `$S/llmobs/judge-agreement.mjs`（同一批判两遍，出 verdict / evidence 的 κ 与弃判率），
判官自己的成绩单在 `$S/llmobs/judge-scorecard.mjs`（产量、弃判率、无效条目率、复验漏没漏）。
