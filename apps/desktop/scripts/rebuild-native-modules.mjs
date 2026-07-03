#!/usr/bin/env node
// 把 node-mac-permissions 的原生 permissions.node 针对「当前 Electron 版本 + 目标架构」重编。
//
// 背景:该模块在 pnpm install(onlyBuiltDependencies)阶段就地用 node-gyp 编译,但只按宿主机
// 架构编一份,且它没有 prebuildify 式的多架构预编译产物兜底。CI 的 x64 打包 job 实际跑在 arm64
// runner 上交叉产出 x64 包(build-pi-binary.mjs / node-pty 已这样处理),node-mac-permissions
// 缺这一环——不重编的话,打进 x64 dmg 的 permissions.node 实际是 arm64 架构,加载必崩。
//
// 实现选型:直接调用 node-gyp(而非 @electron/rebuild 的高层 rebuild() API)。
// 实测 @electron/rebuild@4.0.4 的 rebuild() 在本仓库(pnpm workspace,模块经 shamefully-hoist
// 落在仓库根 node_modules)对本模块跨架构不可靠——同一次调用有时压根不触发 node-gyp 编译、
// 有时产出的仍是宿主机架构;这与它自己的公开类型声明「arch 覆盖仅对下载预编译二进制生效,
// 不支持源码跨架构编译」一致(见 RebuildOptions.arch 的 JSDoc)。直接调用 node-gyp 传
// --arch 则验证可靠:node-gyp 的 rebuildModule() 只在 platform 不匹配时拒绝跨编译,
// arch 会原样透传给 clang 的 `-arch` 参数,Xcode 自带的 clang 是原生跨架构编译器,
// 与 node-pty/build-pi-binary.mjs 已采用的交叉产出策略一致。
//
//   node scripts/rebuild-native-modules.mjs --arch arm64   (默认取 process.arch)
//   node scripts/rebuild-native-modules.mjs --arch x64
//   --force  强制重编

import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const here = dirname(fileURLToPath(import.meta.url));
const desktopRoot = dirname(here); // apps/desktop
const repoRoot = join(desktopRoot, "..", ".."); // monorepo 根:shamefully-hoist 把原生模块 hoist 到这里
const MODULE = "node-mac-permissions";

const log = (msg) => console.log(`[rebuild-native] ${msg}`);

// ── 平台守卫:reply 权限查询是 macOS 专属,非 darwin 跳过(win/linux 误挂也安全)。
if (process.platform !== "darwin") {
  log(`当前平台 ${process.platform} 非 macOS,跳过。`);
  process.exit(0);
}

// ── CLI 参数 ──────────────────────────────────────────────────────────────────
const argv = process.argv.slice(2);
const flagVal = (name) => {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : undefined;
};
const targetArch = flagVal("--arch") ?? process.arch; // arm64 | x64
const force = argv.includes("--force");

// ── 版本 & 路径 ───────────────────────────────────────────────────────────────
const electronVersion = require("electron/package.json").version;
const modulePkgPath = require.resolve(`${MODULE}/package.json`, { paths: [repoRoot, desktopRoot] });
const moduleDir = dirname(modulePkgPath);
const moduleVersion = require(modulePkgPath).version;
const nodeGypBin = require.resolve("node-gyp/bin/node-gyp.js", { paths: [repoRoot, desktopRoot] });
const builtNode = join(moduleDir, "build", "Release", "permissions.node");
const stampPath = join(moduleDir, "build", ".electron-rebuild-stamp");

// ── 幂等 stamp:模块版本 + Electron 版本 + 目标架构。三者不变且 .node 在 → 跳过。
// 注:pnpm install 会重建 build/(抹掉 stamp),故每次 install 后首次调用必重编一次(预期行为:
// install 产出的是宿主机架构,需要重定向到目标 Electron/架构);dev 反复启动后续调用直接命中跳过。
const stamp = `${moduleVersion}:electron-${electronVersion}:${targetArch}`;
if (!force && existsSync(builtNode) && existsSync(stampPath) && readFileSync(stampPath, "utf-8").trim() === stamp) {
  log(`${MODULE} 已按 ${stamp} 就绪,跳过(--force 强制重编)。`);
  process.exit(0);
}

// node-gyp 增量构建有时会复用上一次架构的中间产物(.o 文件按 arch 缓存不完全可靠),
// 保险起见每次重编前清掉 build/ 目录,确保产出架构与本次 --arch 严格一致。
rmSync(join(moduleDir, "build"), { recursive: true, force: true });

log(`重编 ${MODULE} → electron ${electronVersion} / ${targetArch}`);
execFileSync(
  process.execPath,
  [
    nodeGypBin,
    "rebuild",
    "--runtime=electron",
    `--target=${electronVersion}`,
    `--arch=${targetArch}`,
    "--dist-url=https://electronjs.org/headers",
    "--build-from-source",
  ],
  { cwd: moduleDir, stdio: "inherit" },
);

if (!existsSync(builtNode)) {
  console.error(`[rebuild-native] 重编后缺失: ${builtNode}`);
  process.exit(1);
}
writeFileSync(stampPath, stamp);
log(`完成: ${builtNode}`);
