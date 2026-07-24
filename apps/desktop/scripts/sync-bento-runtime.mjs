#!/usr/bin/env node
// 把 vendored bento 运行时空壳同步到 desktop 资源目录(dev 与打包共用同一路径契约):
//   vendor/bento/dist/runtime.html → apps/desktop/resources/slides/bento/runtime.html
// 产物缺失或源码比产物新时,先触发 vendor 包构建再拷贝;electron-builder 的
// extraResources 已含 resources/slides,打包时自动带上。dev 由 desktop dev script 调用,
// 打包由 before-pack.cjs 调用(beforePack 单入口约定)。
import { execSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readdirSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "../../..");
const vendorDir = join(repoRoot, "vendor/bento");
const built = join(vendorDir, "dist/runtime.html");
const target = join(here, "../resources/slides/bento/runtime.html");

/** 递归取 vendor 源文件的最新 mtime(粗粒度陈旧检测,跳过 dist/node_modules)。 */
function newestSourceMtime(dir) {
  let newest = 0;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === "dist" || entry.name === "node_modules") continue;
    const p = join(dir, entry.name);
    if (entry.isDirectory()) newest = Math.max(newest, newestSourceMtime(p));
    else if (/\.(ts|css|html|json|mjs)$/.test(entry.name)) newest = Math.max(newest, statSync(p).mtimeMs);
  }
  return newest;
}

const stale = !existsSync(built) || newestSourceMtime(vendorDir) > statSync(built).mtimeMs;
if (stale) {
  console.log("[bento] runtime 缺失或源码已更新,构建 @cortex-work/bento-slides …");
  // 固定命令串,无外部输入,无注入面。
  execSync("pnpm --filter @cortex-work/bento-slides build", { cwd: repoRoot, stdio: "inherit" });
}

mkdirSync(dirname(target), { recursive: true });
cpSync(built, target);
console.log(`[bento] runtime 已同步 → ${target}`);
