#!/usr/bin/env node
// span-graph skill 入口。实现单源在插件的 claude-code-hooks/hypothesis-graph.mjs（hook 在 SessionEnd 也用它自动出图）；
// 本文件只把命令行透传过去：node from_spans.mjs <spans.jsonl|目录> [--out 目录] [--trace id] [--session id]
import "../../../claude-code-hooks/graph.mjs";
