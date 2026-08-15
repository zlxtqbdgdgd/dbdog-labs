# Claude Code hooks adapter kit（agent 可观测性 · Phase A）

把 Claude Code 从"不进入 Agent Observability"升到"半受控档（全 trace）"的
一组 hook 脚本。零依赖（node 内建），不改 Claude Code 本体、不嵌 SDK。
该目录是可单独分发的 client kit；用户不需要取得或克隆 dbdog-mcp 仓库。

> **默认没有——必须安装**（见下文《安装》，5 步，每步有命令）。
> **装好后怎么触发**：给 Claude Code 发一条以 `诊断:`（或 `diag:`，冒号全半角都认）开头的消息
> ——一条消息 = 一棵 trace 树；普通消息零足迹。全量记录用 `DBDOG_OBS_MODE=always`。

设计总纲：dbdog-web `docs/design/topic-agent-observability.md`；mcp 侧契约：`docs/adr/0008`。

## 前提组件清单（缺一即"静默无树"）

| # | 组件 | 默认就有？ | 怎么办 | 验证命令 |
|---|------|-----------|--------|---------|
| 1 | node ≥ 18（`fetch` 内建） | 通常有 | `brew install node` | `node --version` |
| 2 | dbdog-mcp server 已在 Claude Code 配置 | 否 | `claude mcp add --transport http dbdog-mcp http://<mcp地址>/mcp` | `claude mcp list` |
| 3 | mcp 侧 schema 已放行 trace 字段（ADR-0008） | 服务端 ≥2026-07-09 即有 | 升级服务端 | 见《60 秒自检》第 3 步 |
| 4 | 本 kit 的 5 个 hook 进 settings.json | **否 ← 最常缺的就是这步** | 《安装》Step 2–3 | `jq '.hooks \| keys' ~/.claude/settings.json` |
| 5 | 上报通道（llm/root span 入库用） | 否（不配=只落本地） | 《安装》Step 4 | `curl -s -o /dev/null -w '%{http_code}' -X POST http://<mcp地址>/api/v2/llmobs/spans -H "DD-API-KEY: $DBDOG_OBS_API_KEY" -d '{"spans":[]}'` |

## 分工（mint → propagate → synthesize → sweep）

| hook | 角色 |
|------|------|
| `user-prompt-submit.mjs` | **铸**：一条用户消息 = 一条 trace；铸 trace_id（32 hex）+ root_span_id（前 16 hex 确定性派生），写状态文件 |
| `pre-tool-use.mjs` | **传播**：matcher `mcp__dbdog.*`，出站前经 `updatedInput` 把 `telemetry.trace_id/parent_span_id` 盖上（intent 仍由模型填）；不设 permissionDecision，权限流照常 |
| `stop.mjs`（Stop） | **合成**：增量读主 transcript，按 requestId 归并出 llm span、按 tool_use/tool_result 配对出 tool span；另出 root agent span（input=用户问题，output=最终回答） |
| `stop.mjs`（SubagentStop） | **合成子代理**：只读 `agent_transcript_path`（子代理自己那份 transcript），出子代理的 agent span + 其内部的 llm/tool span |
| `session-start.mjs` | **收尸**：把 `sweep.mjs` 甩到后台（detached）后立刻返回，不占会话启动时间 |
| `sweep.mjs` | 补发卡死的 pending span + 删过期状态文件。不看触发门，也可手动跑：`node sweep.mjs` |

**tool span 由客户端合成**（2026-07-15 治分叉，ADR-0008 补记）：本地工具（Bash/Read/…）
与 MCP 工具全覆盖、失败调用也记——transport 断掉的 MCP 调用只有客户端看得见，服务端视角
反而是空的。mcp 侧 `recordToolCall` 的服务端双写已退役，不再是 tool span 的来源。

## 安装（5 步，全带命令）

> **省事路径**：装好插件（或取到 kit 路径）后直接 `node claude-code-hooks/install.mjs`——
> 它自动从 `~/.claude.json` 检出上报URL、校验 `dbdog_` key、把 `DBDOG_OBS_API_KEY` + `DBDOG_OBS_REPORT_URL`
> 写进 settings.json 的 env 块，诊断总结默认复用 `ANTHROPIC_*`（无需另配）。下面的 5 步是手动等价流程。

**Step 1 — 取 kit，定路径**（本目录随公开仓 `zlxtqbdgdgd/dbdog-labs` 分发：clone 本仓、或从
dbdog 控制台 `/downloads/client-kit/claude-code-hooks.tar.gz` 下载解包；更省事的插件安装
方式见仓根 README——插件方式无需下面的 Step 2–3）：

```sh
KIT=/absolute/path/to/claude-code-hooks   # ← 换成实际绝对路径
ls "$KIT"/{user-prompt-submit,pre-tool-use,stop,session-start,sweep}.mjs   # 五个文件都在才继续
```

**Step 2 — 渲染 settings 片段**（把模板占位路径换成真路径）：

```sh
sed "s|/ABSOLUTE/PATH/TO/dbdog-client-kit/claude-code-hooks|$KIT|g" "$KIT/settings-snippet.json"
```

**Step 3 — 合并进 settings.json。** 选作用域（想清楚再选，"换个目录就失效"多半是选错了这层）：

| 放哪 | 生效范围 | 适用 |
|------|---------|------|
| `~/.claude/settings.json` | **所有项目、所有新目录** | 个人机器，推荐 |
| `<项目>/.claude/settings.json` | 单项目（可提交共享） | 团队仓 |
| `<项目>/.claude/settings.local.json` | 单项目（gitignore） | 个人试验 |

一键合并（有 jq；已存在同名事件的 hooks 会被覆盖，自查 `jq '.hooks|keys'` 后再跑）：

```sh
S=~/.claude/settings.json
cp "$S" "$S.bak"
jq --slurpfile snip <(sed "s|/ABSOLUTE/PATH/TO/dbdog-client-kit/claude-code-hooks|$KIT|g" "$KIT/settings-snippet.json") \
   '.hooks = ((.hooks // {}) + $snip[0].hooks)' "$S" > "$S.new" && mv "$S.new" "$S"
jq -e '.hooks | keys' "$S"   # 应含 UserPromptSubmit / PreToolUse / Stop / SubagentStop / SessionStart
```

**Step 4 — 配上报通道**（不配也能跑：span 只落本地 JSONL）。dbdog 控制台 **settings → api-keys**
签发 `dbdog_` 前缀 key，然后把 `Stop`/`SubagentStop`/`SessionStart` 三处命令里的占位换掉（sweep 也要上报）：

```sh
sed -i.bak \
  -e "s|http://<dbdog-mcp地址>/api/v2/llmobs/spans|http://<实际mcp地址>/api/v2/llmobs/spans|g" \
  -e "s|<填入dbdog_开头的API key>|dbdog_xxxxxxxx|g" ~/.claude/settings.json
```

**Step 5 — 生效**：hooks 在**下一个** Claude Code 会话生效；当前会话要立即生效，
输入 `/hooks` 回车一次（触发配置重载）。

## 60 秒自检（装完必跑）

```sh
# 1) 铸造点：全角冒号触发词应产出 state 文件（用临时目录，不污染真实 state）
export DBDOG_OBS_DIR=$(mktemp -d)
echo '{"session_id":"selftest","prompt":"诊断：自检","cwd":"'$PWD'","transcript_path":"/dev/null"}' \
  | node "$KIT/user-prompt-submit.mjs" && cat "$DBDOG_OBS_DIR/selftest.json"
# 预期：{"active":true,"trace_id":"<32hex>","root_span_id":"<前16hex>",...}

# 2) 注入点：telemetry 应被盖上同一 trace 上下文
echo '{"session_id":"selftest","tool_name":"mcp__dbdog-mcp__list_llmobs_projects","tool_input":{"telemetry":{"intent":"t"}}}' \
  | node "$KIT/pre-tool-use.mjs"
# 预期：updatedInput.telemetry 含 trace_id + parent_span_id，且 parent = trace 前 16 位
unset DBDOG_OBS_DIR

# 3) 端到端：给 Claude Code 发一条「诊断: 随便问点什么」，跑完后——
ls ~/.claude/dbdog-obs/                 # 应出现 <session_id>.json（用过子代理还会有 <session_id>.<agent_id>.json）
tail -3 ~/.claude/dbdog-obs/spans.jsonl # 应有 kind:"agent"(root) 与 kind:"llm"/"tool" 的行
# LLM Obs UI 按 ml_app:<目录名> 过滤 traces，应看到完整树
# （起过子代理的话是三层：root → [tool] Agent → [agent] claude-code.subagent → 子代理的 llm/tool）
```

## 产物与配置

- 状态：`~/.claude/dbdog-obs/<session_id>.json`（trace 上下文 + 主 transcript 游标）
- 子代理状态：`~/.claude/dbdog-obs/<session_id>.<agent_id>.json`（每子代理一份，各写各的——
  并行子代理会同时触发 SubagentStop，共用一个文件必然读-改-写互相覆盖）
- 状态文件里的 `pending_spans` 只存 span_id，全文回捞自 spans.jsonl（见《收尸机制》）
- span：`~/.claude/dbdog-obs/spans.jsonl`（每行一个 span，本地真相源永远先落）
- **上报 dbdog**（Phase C，ADR-0034）：设 `DBDOG_OBS_REPORT_URL`（`http://<dbdog-mcp 地址>/api/v2/llmobs/spans`）
  + `DBDOG_OBS_API_KEY`（控制台 settings/api-keys 签发）后，Stop / SubagentStop 合成的 span 会
  best-effort 从 MCP 边缘口 POST 入库；未设两 env = 只落本地，行为与 Phase A 相同。
  **注意这个 URL 是 mcp 边缘口，只收 `POST /spans`；查 trace 要走 dbdog-server 本体**
- **诊断流程总结**（本地大模型生成，2026-08-11）：默认复用 Claude Code 自身的 `ANTHROPIC_*`（或显式配齐 `DBDOG_SUMMARY_LLM_*`，见下）后，
  Stop 在「本轮有新工具调用」时 detached 起后台 `summary-worker.mjs`，读本 trace 的 span →
  裁剪（MCP 工具按 intent 留信号行 + Read/Grep/Bash 代码 token + agent 结论）→ 调本地大模型按
  提示词成文 → 作为一条 `kind=workflow`/`name=diagnosis-summary` 的 span 推上去；控制台 banner 读它。
  不阻塞 Stop（用户零等待）、后写赢；未配/失败 = 没总结，不影响 trace。设计见
  `dbdog-web/docs/design/llmobs-investigation-narrative.md`。
- env：`DBDOG_OBS_DIR`（状态/产物目录）、`DBDOG_OBS_SPANS`（spans 路径）、
  `DBDOG_OBS_CONTENT_CHARS`（内容截断，默认 8000，对齐 `DBDOG_TELEMETRY_OUTPUT_CHARS` 先例）、
  `DBDOG_OBS_ML_APP`（应用名标签，打进 root/llm span 的 `tags.ml_app`；缺省 = 项目目录名。
  复盘按它过滤——同一台机器上编码会话与真诊断靠它分开）、
  `DBDOG_OBS_STORE_LLM_INPUT`（llm span 的每轮完整 prompt 是否落本地 JSONL，默认开；
  `0`/`off` 关；只进 `spans.jsonl`，上报前剥离）、
  `DBDOG_OBS_CTX_BUF_CHARS`（上下文滚动缓冲上限，默认 200000 字符——每轮 prompt 从它
  截尾，也防状态文件无限膨胀）、
  `DBDOG_OBS_REPORT_TIMEOUT_MS`（上报超时，默认 3000；透明代理/隧道后的机器放宽到
  10000–15000，见故障排查倒数第二行）、
  `DBDOG_SUMMARY_LLM_*`（诊断流程总结的 LLM 端点，**可选**）：`summaryEnv` 现先取 `DBDOG_SUMMARY_LLM_*`，
  缺/占位则**回退到 Claude Code 自身的 `ANTHROPIC_*`**——
  `BASE_URL`：`DBDOG_SUMMARY_LLM_BASE_URL` → `ANTHROPIC_BASE_URL` → `ANTHROPIC_API_URL` → `https://api.anthropic.com`；
  `API_KEY`：`DBDOG_SUMMARY_LLM_API_KEY` → `ANTHROPIC_AUTH_TOKEN` → `ANTHROPIC_API_KEY`；
  `MODEL`：`DBDOG_SUMMARY_LLM_MODEL` → `ANTHROPIC_MODEL`（剥 `[1m]` 路由后缀）→ 按 host 判定
  （`bigmodel.cn`→`glm-5.2`、`anthropic.com`→`claude-haiku-4-5`、其余→`glm-5.2` 并 stderr 提示）。
  所以**多数情况无需配** `DBDOG_SUMMARY_LLM_*`——Claude Code 能跑、总结就能出（避免把会轮换的 token
  抄一份进 env，轮换两处不同步）。仅当想换端点时才覆盖这三项；`DBDOG_SUMMARY_LLM_TIMEOUT_MS` 默认 30000。
  API_KEY 整条解析值缺失 = 没总结，trace 不受影响。

## 触发门（DBDOG_OBS_MODE，2026-07-11）

默认**不再全量记录**——触发了才建 trace，不触发全链零足迹（不铸号、不注入、
mcp 不双写、不上报，跟没装一样）：

| 模式 | 行为 | 用在哪 |
|------|------|--------|
| `triggered`（默认） | prompt 以触发词开头才记（`DBDOG_OBS_TRIGGER`，默认 `诊断:`；`diag:` 恒收；**冒号全半角都认**——中文输入法的「：」照样触发） | 日常工作仓（如 dbdog-web） |
| `always` | 每条消息都记 | 诊断专用目录（如 dbdog-test，配在 UserPromptSubmit 命令前） |
| `off` | 彻底关闭 | — |

实现细节：未触发的 prompt 会把会话 state 置 `active:false`——否则该轮的工具调用会被
注入**上一条** trace 的 id、模型消息被合成进上一条 trace（错误归属）。

## 故障排查（症状 → 原因 → 处置）

| 症状 | 最可能原因 | 处置 |
|------|-----------|------|
| 一个 span 都没有 | 消息没带触发词 | 以 `诊断:` 开头重发；或 `DBDOG_OBS_MODE=always` |
| hook 完全不触发（state 文件不出现） | 会话早于安装 / settings 没合对 | `/hooks` 回车重载或开新会话；`jq -e '.hooks\|keys' ~/.claude/settings.json` |
| 树里看不到子代理内部的工具调用（只有一条 `Agent` tool span，底下是空的） | 旧版 `stop.mjs` 只读主 transcript，而子代理内容在独立文件里 | 升级到 2026-08-09 之后的 kit（SubagentStop 改读 `agent_transcript_path`） |
| span 只在本地 `spans.jsonl`，平台上没有 | 上报 env 没配齐（两个都要），或上报失败后卡在 `pending_spans` 里（见《收尸机制》） | 补 `DBDOG_OBS_REPORT_URL` + `DBDOG_OBS_API_KEY`（安装 Step 4），用前提清单第 5 行的 curl 验证；已卡住的跑 `node sweep.mjs` 补发 |
| span 被服务端拒收（4xx） | 真实拒收原因只有：`trace_id`/`span_id`/`kind` 缺失、`ts` 非 RFC3339、同批 `span_id` 重复、批量超 1000 条或 5MB | 照此自查。**`parent_id` 服务端不做任何校验**，不必等于 `trace_id` 前 16 hex；另注意字段名是 `parent_id`，写成 `parent_span_id` 会被静默丢弃 |
| env 配齐了、`sweep.mjs` 也补发不掉，`pending_spans` 反而越滚越大 | 上报超时。机器挂透明代理/隧道（TUN 模式客户端连 `--noproxy` 都截）时首字节被拉到 1–4s，骑在默认 3s 上；失败一轮包更大、更超时 | 量一下：`time curl -s -o /dev/null -X POST $DBDOG_OBS_REPORT_URL -H "DD-API-KEY: $DBDOG_OBS_API_KEY" -d '{"spans":[]}'`（400「spans 为空」= 通）。超 1s 就给 mcp 地址加代理直连规则（根治），或 `DBDOG_OBS_REPORT_TIMEOUT_MS=15000`（保底） |
| settings 里有 `curl → localhost:8126/claude/hooks` 一类 hook | 历史遗留实验，**不属于本 kit**，静默空转 | 删除；本 kit 全链路不经过 8126 |

## span 形状（v2 三层树，2026-08-09）

主线的 llm/tool span 仍平挂 root；起了子代理才有嵌套：

```
[agent] claude-code.task                 root_span_id = trace_id 前 16 hex
├─ [llm] anthropic.messages
├─ [tool] Bash
└─ [tool] Agent                          父视角的调用（耗时/入参/结果）
   └─ [agent] claude-code.subagent       子代理自身（input=子代理 prompt、output=其最终产出）
      ├─ [llm] anthropic.messages
      └─ [tool] Bash
```

**父子挂载靠确定性派生，两侧不通信**——SubagentStop 触发时，父侧那行 tool_result 还没落盘，
当场拿不到父 span_id，只能各自算：

| span | span_id |
|------|---------|
| 父侧 `Agent` tool span | `sha256(trace_id + ":tool:" + agent_id)[:16]` |
| 子代理 `agent` span | `sha256(trace_id + ":" + agent_id)[:16]` |

`agent_id` 的锚点：父侧 tool_result 行的 `toolUseResult.agentId`，与 SubagentStop 入参的
`agent_id` 一致。子代理的所有 span 带 `tags.sidechain="1"` + `agent_id` + `agent_type`。

父侧 `Agent` tool span 另带子代理的总开销，**不展开子树就能看出它烧了多少**：

| tag | 来源 |
|-----|------|
| `agent_total_tokens` | `toolUseResult.totalTokens` |
| `agent_tool_use_count` | `toolUseResult.totalToolUseCount` |
| `agent_model` | `toolUseResult.resolvedModel`（子代理实际用的模型，可能与主线不同） |

这几个走 `tags`（字符串）而不是 `tokens_*` 一等字段：子代理内部的 llm span 已经各自
记了 token，占一等字段会在读侧被重复求和。

**一次模型调用 = 一个 llm span**：transcript 把一次 API 响应按内容块拆成多条 assistant 行
（requestId 相同、usage 重复），合成器按 requestId 归并——逐行出 span 会虚增轮数 2-3 倍
（首轮闭环实测坑）。
llm span 的 `input` 恒 null（上报侧不推全文，远端只看树形与 token）；每轮完整 prompt
按 `DBDOG_OBS_STORE_LLM_INPUT`（默认开）截尾存进本地 `input_local`（截断上限同
`DBDOG_OBS_CONTENT_CHARS`，取尾部——新注入的内容才解释上下文为什么膨胀；系统提示不在
transcript 里、tool_use 参数不入缓冲、长度以 usage 的 token 计数为准）。`input_local`
**只进本地 `spans.jsonl`，reportSpans 上报前剥离**，远端 schema 不动、带宽不浪费。
任务级 in/out 在 root span，子代理级在其 agent span。`duration_ms` 是近似值
（前一条 entry 落盘 → 组内末行落盘），打 `duration_estimated` 标区分。

## 已知语义（读侧须知）

- **root span 会重发**：同一 trace 多次 Stop（如用户中断后继续）时 root 以同 span_id
  重新追加（output/duration 刷新）——读侧按 span_id"后写赢"去重。子代理的 agent span
  同理（SubagentStop 重入时同 span_id 重发）。
- **hook 装好前已开的会话**：无状态文件 → 全部 hook 静默放行，不产 span。
- **老版 Claude Code**：SubagentStop 不带 `agent_transcript_path` 时静默空转——那时子代理内容
  就写在主 transcript 里，Stop 会一并读到，不丢数据。
- **纪律**：任何错误只写 stderr、exit 0——hook 绝不打断会话（同 `src/telemetry.ts`）。

## 收尸机制（sweep，2026-08-09）

上报失败的 span 会存进状态文件的 `pending_spans` 等下次重试，但**会话结束后就再没有
下一轮触发**，从此永久卡死（子代理必然中招，结束即无下次）。实测一台机器 35 个状态
文件中 5 个有堆积、共 737 条从未送达。`sweep.mjs` 就是来收这个尸的：

| 参数 | 默认 | 含义 |
|------|------|------|
| `DBDOG_OBS_SWEEP_IDLE_MS` | 2 小时 | 状态文件多久没被写过才算"会话已结束"，可以安全接管 |
| `DBDOG_OBS_SWEEP_TTL_MS` | 7 天 | 已排空的主会话状态文件保留多久 |
| `DBDOG_OBS_SWEEP_SUB_TTL_MS` | 1 天 | 子代理状态文件保留多久（不会复活，排空即可删） |
| `DBDOG_OBS_SWEEP_BATCH` | 50 | 单批补发条数（服务端限 1000 条 / 5MB；2026-08-14 自 200 调小，配合 sweep 侧 10s 缺省上报超时——`DBDOG_OBS_REPORT_TIMEOUT_MS` 显式配置仍最高优先） |

三条设计要点：

- **靠 mtime 老化避开竞态**：只碰 `IDLE` 之外的文件。那种文件的会话必已结束、没有写者，
  读改写不需要加锁。活跃会话的状态文件一律不碰。
- **pending 只存 span_id**：全文回捞自 `spans.jsonl`（真相源）。旧格式存全文，实测把单个
  状态文件撑到 315 KB。两种格式都兼容。
- **宁可重发不可丢**：`span_id` 固定，服务端是 `ReplacingMergeTree` + `ORDER BY
  (trace_id, ts, span_id)`，重复补发会被去重。任何一批失败就整体留着下次再来。

`spans.jsonl` 扩展名是 `.jsonl`，天然不在状态文件（`.json`）的扫描范围内——补发要靠它
回捞，任何情况下都不得删。

## 已知限制

- **pending 记录本身丢了的救不回来**：2026-08-09 之前的 `user-prompt-submit.mjs` 每轮
  重建 state 时不继承 `pending_spans`，等于把"这些 span 没送达"的事实一起抹掉。实测有
  一条 trace 本地 219 条、服务端 110 条，缺的 109 条不在任何状态文件里，sweep 无从下手。
  该缺陷已修（新一轮触发会继承 pending），但此前丢的记录只能靠人工比对本地 JSONL 补。
- **`spans.jsonl` 无限增长**：只追加不轮转（实测 9 天 3006 行 / 5.2 MB）。收尸要按 id
  回捞就更依赖它，不能随便删。轮转策略尚未设计。
