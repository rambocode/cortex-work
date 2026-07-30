#!/usr/bin/env node
// 把 pi(@earendil-works/pi-coding-agent)用 bun 编译成自包含单二进制 + 旁置资产,
// 产出到 apps/desktop/resources/pi/。Cortex 打包/启动时调用该二进制(见 pi-locate.ts),
// 彻底脱离 Electron asar/node_modules 的依赖解析(pi 是纯 ESM、依赖闭包庞大,塞进 asar
// 会反复出 minimatch/typebox/undici 这类解析问题;bun --compile 把依赖全 inline 进二进制)。
//
// 幂等(两级):
//  1. stamp 快路径:resources/pi/.pi-version 记录 <piVersion>-<bunTarget>-bun<bunVersion>,
//     未变且二进制在则零成本跳过(dev 启动每次跑也不重编)。
//  2. 产物缓存:.pi-build-cache/<key>/ 按 key 缓存整套产物(二进制+旁置资产)。发布流程
//     arm64→x64 串行构建共享 resources/pi/ 目录,原单值 stamp 会导致每次发布双架构都
//     重编 ~73MB 二进制;bun 产物字节若不确定,pi 版本没变也会放大自动更新差量 ~20MB。
//     缓存命中改为整目录拷贝——既省编译时间,又保证跨发布字节级一致,差量得以收敛。
// 强制重编:node scripts/build-pi-binary.mjs --force
//
// 跨平台构建:
//   node scripts/build-pi-binary.mjs --platform darwin --arch x64
//   node scripts/build-pi-binary.mjs --platform win32  --arch x64
//   默认(无参数): darwin-arm64
//
// 依赖 bun(本机 ~/.bun/bin/bun 或 PATH;CI 打包需安装 bun)。

import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
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
const cacheRoot = join(desktopRoot, ".pi-build-cache");

if (!existsSync(piPkgDir)) {
  console.error(`[build-pi-binary] 找不到 pi 包: ${piPkgDir}\n请先 pnpm install。`);
  process.exit(1);
}

const piVersion = JSON.parse(readFileSync(join(piPkgDir, "package.json"), "utf-8")).version;

// 定位 bun:优先 BUN_PATH / ~/.bun/bin/bun,回退 PATH。(前移到缓存判断之前:key 需要 bun 版本)
const bun =
  [process.env.BUN_PATH, join(process.env.HOME || "", ".bun/bin/bun")].find(
    (b) => b && existsSync(b),
  ) || "bun";

// 缓存 key 必须含 bun 版本:bun 升级后同一 pi 版本的编译产物必然不同,
// 不含会拷出旧 bun 编的二进制,形成假幂等。
const bunVersion = execFileSync(bun, ["--version"], { encoding: "utf-8" }).trim();
const cacheKey = `${piVersion}-${bunTarget}-bun${bunVersion}`;
const cacheDir = join(cacheRoot, cacheKey);

// stamp 快路径:key 未变且二进制在,零成本跳过(dev 每次启动都会跑本脚本)。
if (!force && existsSync(binPath) && existsSync(stampPath)) {
  if (readFileSync(stampPath, "utf-8").trim() === cacheKey) {
    log(`pi@${piVersion} (${bunTarget}) 二进制已最新,跳过(--force 强制重编)。`);
    process.exit(0);
  }
}

// 缓存命中路径:整目录拷贝(二进制+旁置资产一体缓存,不存在漏拷),免 bun 编译。
// 这是发布串行双架构的核心收益:pi/bun 版本未变时,arm64/x64 交替构建都直接复用。
if (!force && existsSync(join(cacheDir, binName))) {
  log(`缓存命中 ${cacheKey},跳过 bun 编译,拷贝缓存产物 → ${outDir}`);
  rmSync(outDir, { recursive: true, force: true });
  cpSync(cacheDir, outDir, { recursive: true });
  writeFileSync(stampPath, cacheKey);
  log(`完成(来自缓存): ${binPath}`);
  process.exit(0);
}

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

writeFileSync(stampPath, cacheKey);

// 回填缓存(先清防脏),供下次同 key 构建直接拷贝;stamp 一并入缓存无害。
rmSync(cacheDir, { recursive: true, force: true });
mkdirSync(cacheRoot, { recursive: true });
cpSync(outDir, cacheDir, { recursive: true });

// 修剪:删除 pi 版本前缀不同的旧缓存目录,防止无限增长。
// 同版本多 target(darwin-arm64/x64、win32)都保留——这正是双架构串行构建的复用点。
try {
  for (const entry of readdirSync(cacheRoot)) {
    if (!entry.startsWith(`${piVersion}-`)) {
      rmSync(join(cacheRoot, entry), { recursive: true, force: true });
      log(`清理旧版本缓存: ${entry}`);
    }
  }
} catch (e) {
  log(`⚠️ 缓存修剪失败(不影响构建): ${e.message}`);
}

log(`完成: ${binPath}`);
