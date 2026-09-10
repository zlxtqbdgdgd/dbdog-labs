// spawn-script.mjs — 两条 loop 编排共用的「跑一个同仓脚本」，只为去掉那份两处一模一样的副本。
//
// `setEncoding("utf8")` 是防御性的：不设的话是对每个 Buffer 各自 toString，
// 理论上一个中文字符跨在读块边界上会被劈成两半。**2026-09-10 实测在本仓这条路上没有复现**
// （真正把 JSON 截断的是上游 `loop-pending.mjs` 写完就 `process.exit`，见它那条测试）——
// 所以这里不挂守门测试，别为它编一条。
import path from "node:path";
import { spawn } from "node:child_process";

/**
 * @param {string} dir      脚本所在目录
 * @param {string} script   脚本文件名
 * @param {string[]} args   参数
 * @param {{capture?: boolean}} o  capture=true 收 stdout（stderr 仍直通，进度看得见）
 * @returns {Promise<{code: number|null, out: string}>}
 */
export function spawnScript(dir, script, args, { capture = false } = {}) {
  return new Promise((resolve) => {
    const p = spawn(process.execPath, [path.join(dir, script), ...args], {
      stdio: capture ? ["ignore", "pipe", "inherit"] : "inherit",
      env: process.env,
    });
    let out = "";
    if (capture) {
      p.stdout.setEncoding("utf8");
      p.stdout.on("data", (d) => { out += d; });
    }
    p.on("close", (code) => resolve({ code, out }));
  });
}
