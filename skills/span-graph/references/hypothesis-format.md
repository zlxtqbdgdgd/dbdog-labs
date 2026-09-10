# 假设一行的格式（intent-v2，2026-09-10 起）

定义的单源是 dbdog-mcp 里 `telemetry.intent` 参数的 schema 描述（随 tools/list 到达每个客户端）；
这里只是速查，与它不一致以它为准。

```
[H2.1<H1.2] type=cause; claim=connection waits come from slow downstream I/O; expect=disk read latency rises with the waits, otherwise refuted; close=H1.1:refuted; intent=read disk latency for the window
```

| 字段 | 何时 | 取值 |
|---|---|---|
| `[H2.1<H1.2]` | 每次调用必带 | 编号 `H` + 数字点分；派生假设 `<` 接父编号，后面不再有 `>`。解析器容忍编号带一个 `-` 后缀（如 `[H0-anchor]`、`[H1-root]`，模型偶尔这样写），但约定仍是 `H1` / `H2.1`，后缀是容错不是格式 |
| `type=` | 编号首次出现 | `symptom`（能不能锚定到实例/语句）/ `cause`（为什么） |
| `claim=` | 编号首次出现 | 这个假设自己的内容，子假设写它与兄弟的区别 |
| `expect=` | 每次 | 看到什么算成立、看到什么算证伪 |
| `close=` | 只在这次调用真要关闭某个假设时 | `H1:refuted` / `H1:supported` / `H1:inconclusive`，多个用 `,` |
| `intent=` | 每次 | 这一次查什么 |
| `basis=` | 假设来自源码时 | `source`（另有 `telemetry` / `log` / `user`） |
| `code_ref=` | `basis=source` 时 | `file:line` 或函数名 |

正文里提出新假设单独一行：`Propose [H2] type=cause; claim=…`。
报告的 `## How do we know` 结尾放 hypothesis ledger，每个编号一行：`H1 refuted — 依据`。

历史 span 的中文键（类型/假设/判据/关/意图，证伪/证实/未决，提出，## 假设收口）解析器仍认。

图落 server：hook 在 SessionEnd 出图后，紧凑形的图（去掉每次调用的 input/output/intent，`graph_version:1`）会随
root span 推到 server（server 存 root 行的 `graph` 列），web 读 `GET /api/v2/llmobs/trace/{id}/graph`。
