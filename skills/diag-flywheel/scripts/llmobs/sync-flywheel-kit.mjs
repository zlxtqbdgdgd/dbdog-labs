#!/usr/bin/env node
// sync-flywheel-kit.mjs — 把飞轮的**客户端脚本**镜像进 dbdog-labs 插件（飞轮 §12.5）。
//
// ## 为什么要镜像，而不是让用户去检出 mcp 仓
// 发布配方打出来的 mcp 产物只有 index.js + package.json + etc/env + VERSION（`recipes/dbdog-mcp.sh`
// 自述「避免把源码仓的构建脚本一并带入产物」），`scripts/` 一个都不进；而用户手上有的是
// `dbdog-agent-obs` 插件（hooks 已经装在那儿）。所以客户端脚本的唯一到达路径是插件。
//
// ## 为什么母版留在这里，而不是搬去 labs
// 这 19 个文件里有 7 个是 `scripts/e2e/lib/*`，mcp 自己的 e2e（`run-round-local.mjs` /
// `ingest-diagnosis.mjs` 与 4 个测试）正用着它们。把根搬走等于拆了 mcp 的测试设施；
// 反过来让 mcp 去 import 一个公开分发仓的插件目录，本末倒置。于是照家族既有的 hooks 模式办：
// **母版在实现仓、镜像进 labs、一致性由守门测试钉住**（hooks 是反方向的同一套：母版在 labs，
// runner 按 `hooks/hooks.json` 镜像，缺母版 fail closed）。
//
// ## 镜像是**纯拷贝，零改写**
// labs 侧保持 `scripts/llmobs/` 与 `scripts/e2e/lib/` 的同名布局，于是脚本里
// `../e2e/lib/agent-cli.mjs` 这类相对路径原样成立——不用在同步时重写 import，
// 也就没有「改了一处忘了另一处」的漂移面（军规 3）。
//
// 用法：
//   node scripts/llmobs/sync-flywheel-kit.mjs [--check] [--labs <dir>]
//     --check  只比对不写（守门测试与 CI 用），有差异退 1 并列出文件
//     --labs   labs 检出目录，默认同级 `../dbdog-labs`（家族平级 checkout 约定）
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const MCP_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const argOf = (n, d) => { const i = process.argv.indexOf(n); return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : d; };
const CHECK = process.argv.includes("--check");
const LABS = path.resolve(argOf("--labs", path.join(MCP_ROOT, "..", "dbdog-labs")));
const DEST = path.join(LABS, "skills", "diag-flywheel", "scripts");

/**
 * 镜像清单 = 九个入口脚本的依赖闭包（`scripts/llmobs/` 12 个 + `scripts/e2e/lib/` 7 个）。
 * **不写死列表**：从入口出发解析 import，闭包变了这里自动跟着变（军规 3：能推导的不钉字面量）。
 * 测试与夹具不镜像——用户跑的是脚本，不是我们的守门。
 */
const ENTRIES = [
  "scripts/llmobs/run-experiment.mjs",
  "scripts/llmobs/curate-record.mjs",
  "scripts/llmobs/probe.mjs",
  "scripts/llmobs/judge-package-export.mjs",
  "scripts/llmobs/judge-package-import.mjs",
  "scripts/llmobs/training-corpus-export.mjs",
  "scripts/llmobs/loop-pending.mjs",
  "scripts/llmobs/case-history.mjs",
  "scripts/llmobs/fix-mark.mjs",
  // 2026-09-11 加两条 loop 的入口：它们此前只在源码仓里，于是别人要跑就得 clone 整个 mcp
  // 仓只为拿两个文件（那台机器上的 runner 靠一个 MCP_REPO 变量指过去）。进了镜像之后，
  // 装了插件就有脚本，MCP_REPO 这个变量整个消失。
  // 闭包会自动带上它们独有的三个依赖：spawn-script / judge-session / case-diag-client。
  "scripts/llmobs/loop-diagnose.mjs",
  "scripts/llmobs/loop-judge.mjs",
];

/**
 * 闭包扫不到的**附带资产**：不是被 import 的，是运行时按路径读的。
 *
 * `diag-guard.py` 由 blind-guard.mjs 的 installGuardCopy 按同目录相对路径读出来、注入禁读根、
 * 拷成临时副本。闭包靠扫 import 语句算依赖，这种读法一个字都扫不到——**漏了不会有编译错，
 * 会在用户第一次装护栏时 ENOENT**，而那正是盲测护栏该生效的时刻。
 *
 * 加东西到这里之前先想：它是不是本来就该改成 import？能 import 的一律走闭包，
 * 这张表只收真的没法 import 的（非 JS 资产）。
 */
const EXTRA_ASSETS = [
  "scripts/llmobs/lib/diag-guard.py",
];

function closure() {
  const seen = new Set();
  const queue = [...ENTRIES];
  while (queue.length) {
    const rel = queue.pop();
    if (seen.has(rel)) continue;
    const abs = path.join(MCP_ROOT, rel);
    if (!fs.existsSync(abs)) throw new Error(`镜像清单里的文件不存在：${rel}`);
    seen.add(rel);
    const src = fs.readFileSync(abs, "utf8");
    for (const m of src.matchAll(/from\s+"(\.[^"]+)"/g)) {
      const tgt = path.resolve(path.dirname(abs), m[1]);
      const relTgt = path.relative(MCP_ROOT, tgt);
      if (relTgt.startsWith("..")) throw new Error(`闭包跑出仓外：${m[1]}（来自 ${rel}）`);
      // 测试文件不进镜像；夹具目录同理（它们只被 .test.mjs 引用，不在运行路径上）
      if (!relTgt.includes(".test.") && !relTgt.includes("__fixtures__")) queue.push(relTgt);
    }
  }
  return [...seen].sort();
}

const files = [...closure(), ...EXTRA_ASSETS];
// 自身也要进镜像：用户拿到的那份要能自证「我是从哪同步来的」，也方便他 --check 自己那份没被改花
files.push(path.relative(MCP_ROOT, fileURLToPath(import.meta.url)));

if (!fs.existsSync(LABS)) {
  console.error(`✗ labs 检出不在：${LABS}（家族约定五仓平级 checkout；或用 --labs 指路）`);
  process.exit(1);
}

const diffs = [];
for (const rel of files) {
  const src = fs.readFileSync(path.join(MCP_ROOT, rel), "utf8");
  // labs 侧丢掉 `scripts/` 这一层（DEST 本身就是 scripts/），其余布局原样保留
  const dst = path.join(DEST, rel.replace(/^scripts\//, ""));
  const cur = fs.existsSync(dst) ? fs.readFileSync(dst, "utf8") : null;
  if (cur === src) continue;
  diffs.push(rel);
  if (!CHECK) {
    fs.mkdirSync(path.dirname(dst), { recursive: true });
    fs.writeFileSync(dst, src);
  }
}

// 镜像里多出来的陈迹要报：母版删了文件而镜像还留着，用户就会拿到一份早就没人维护的脚本
const want = new Set(files.map((r) => path.join(DEST, r.replace(/^scripts\//, ""))));
const stale = [];
const walk = (dir) => {
  if (!fs.existsSync(dir)) return;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p);
    else if (!want.has(p)) stale.push(path.relative(DEST, p));
  }
};
walk(DEST);

if (CHECK) {
  if (diffs.length || stale.length) {
    console.error(`✗ 镜像与母版不一致：${diffs.length} 个文件有差异，${stale.length} 个是陈迹`);
    for (const d of diffs) console.error(`  差异 ${d}`);
    for (const s of stale) console.error(`  陈迹 ${s}`);
    console.error("  跑 `node scripts/llmobs/sync-flywheel-kit.mjs` 重新镜像");
    process.exit(1);
  }
  console.log(`✓ 镜像与母版一致（${files.length} 个文件）`);
} else {
  for (const s of stale) fs.rmSync(path.join(DEST, s));
  console.log(`✓ 已镜像 ${files.length} 个文件 → ${DEST}`);
  console.log(`  本次更新 ${diffs.length} 个${stale.length ? `，清掉陈迹 ${stale.length} 个` : ""}`);
}
