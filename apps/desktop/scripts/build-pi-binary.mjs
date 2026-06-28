#!/usr/bin/env node
// 把 pi(@earendil-works/pi-coding-agent)用 bun 编译成自包含单二进制 + 旁置资产,
// 产出到 apps/desktop/resources/pi/。Cortex 打包/启动时调用该二进制(见 pi-locate.ts),
// 彻底脱离 Electron asar/node_modules 的依赖解析(pi 是纯 ESM、依赖闭包庞大,塞进 asar
// 会反复出 minimatch/typebox/undici 这类解析问题;bun --compile 把依赖全 inline 进二进制)。
//
// 幂等:resources/pi/.pi-version 记录已编译的 pi 版本+平台,版本未变且二进制存在则跳过(dev
// 启动每次跑也不会重编)。强制重编:node scripts/build-pi-binary.mjs --force
//
// 跨平台构建:
//   node scripts/build-pi-binary.mjs --platform darwin --arch x64
//   node scripts/build-pi-binary.mjs --platform win32  --arch x64
//   默认(无参数): darwin-arm64
//
// 依赖 bun(本机 ~/.bun/bin/bun 或 PATH;CI 打包需安装 bun)。

import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const desktopRoot = dirname(here); // apps/desktop
const piPkgDir = join(desktopRoot, "node_modules/@earendil-works/pi-coding-agent");

const log = (msg) => console.log(`[build-pi-binary] ${msg}`);

// ── CLI 参数解析 ──────────────────────────────────────────────────────────────
const argv = process.argv.slice(2);
const flagVal = (name) => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : undefined; };
const targetPlatform = flagVal("--platform") ?? "darwin";
const targetArch = flagVal("--arch") ?? "arm64";
const force = argv.includes("--force");
const isWindows = targetPlatform === "win32";

// bun --compile target 映射（bun 用 "darwin"/"windows"/"linux"）
const bunPlatform = targetPlatform === "win32" ? "windows" : targetPlatform;
const bunTarget = `bun-${bunPlatform}-${targetArch}`;

const outDir = join(desktopRoot, "resources/pi");
const binName = isWindows ? "pi.exe" : "pi";
const binPath = join(outDir, binName);
const stampPath = join(outDir, ".pi-version");
const stampKey = `${targetPlatform}-${targetArch}`;

if (!existsSync(piPkgDir)) {
  console.error(`[build-pi-binary] 找不到 pi 包: ${piPkgDir}\n请先 pnpm install。`);
  process.exit(1);
}

const piVersion = JSON.parse(readFileSync(join(piPkgDir, "package.json"), "utf-8")).version;

// 幂等:版本+平台未变且二进制在,直接跳过。
if (!force && existsSync(binPath) && existsSync(stampPath)) {
  if (readFileSync(stampPath, "utf-8").trim() === `${piVersion}:${stampKey}`) {
    log(`pi@${piVersion} (${stampKey}) 二进制已最新,跳过(--force 强制重编)。`);
    process.exit(0);
  }
}

// 定位 bun:优先 BUN_PATH / ~/.bun/bin/bun,回退 PATH。
const bun =
  [process.env.BUN_PATH, join(process.env.HOME || "", ".bun/bin/bun")].find(
    (b) => b && existsSync(b),
  ) || "bun";

log(`编译 pi@${piVersion} → ${binPath} (target: ${bunTarget})`);
rmSync(outDir, { recursive: true, force: true });
mkdirSync(outDir, { recursive: true });

// bun --compile:把 pi 的 bun 入口 + 整个依赖闭包打成单可执行文件。
execFileSync(
  bun,
  [
    "build",
    "--compile",
    "--target",
    bunTarget,
    join(piPkgDir, "dist/bun/cli.js"),
    "--outfile",
    binPath,
  ],
  { stdio: "inherit" },
);

// 旁置资产:bun 二进制模式下 config.js 按「二进制所在目录」定位资产
//(getThemesDir→<bin>/theme、getInteractiveAssetsDir→<bin>/assets、
// getExportTemplateDir→<bin>/export-html、getPackageJsonPath→<bin>/package.json)。
const dist = join(piPkgDir, "dist");
log("拷贝旁置资产(theme/assets/export-html/package.json/wasm)…");
cpSync(join(dist, "modes/interactive/theme"), join(outDir, "theme"), { recursive: true }); // 必需:启动 initTheme
cpSync(join(dist, "modes/interactive/assets"), join(outDir, "assets"), { recursive: true });
cpSync(join(dist, "core/export-html"), join(outDir, "export-html"), { recursive: true });
cpSync(join(piPkgDir, "package.json"), join(outDir, "package.json")); // config.js 启动读 version 等

// photon wasm(图片处理):Cortex 走 --mode json 文本回路、不传图片,故非必需;尽力拷,失败仅告警。
try {
  const req = createRequire(join(piPkgDir, "package.json"));
  let wasmSrc;
  try {
    wasmSrc = req.resolve("@silvia-odwyer/photon-node/photon_rs_bg.wasm");
  } catch {
    wasmSrc = join(dirname(req.resolve("@silvia-odwyer/photon-node/package.json")), "photon_rs_bg.wasm");
  }
  cpSync(wasmSrc, join(outDir, "photon_rs_bg.wasm"));
} catch (e) {
  log(`⚠️ 未拷 photon wasm(图片处理),不影响文本回路: ${e.message}`);
}

writeFileSync(stampPath, `${piVersion}:${stampKey}`);
log(`完成: ${binPath}`);
