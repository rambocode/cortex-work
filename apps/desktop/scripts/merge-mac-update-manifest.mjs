#!/usr/bin/env node
// 合并 macOS arm64、x64 两次独立 electron-builder 构建各自产出的 latest-mac.yml,
// 产出一份 files[] 同时含两种架构 ZIP 条目的清单。DMG 不参与 Squirrel.Mac 自动更新，
// 也不再进入 GitHub Release；最终清单出现非 ZIP 条目应直接拒绝发布。
//
// 背景(v0.1.27 发布事故):electron-updater 的 MacUpdater 只有当 files[] 同时存在
// arm64 与非 arm64 条目时才按机器架构过滤;清单里只剩一种架构时会直接下载唯一存在的那个,
// 导致 arm64 机器被误装 x64(Rosetta)包。本脚本的前置/后置断言就是对这次事故的程序化防线:
// 任何一份清单"名不副实"或合并结果不是双架构,直接 abort、不写文件。
//
// 用法(合并):
//   node scripts/merge-mac-update-manifest.mjs --arm64 <path> --x64 <path> --out <path>
// 用法(独立复核,不合并、只校验一份已存在的清单是否双架构):
//   node scripts/merge-mac-update-manifest.mjs --verify <path>
// CI 发布前用 --verify 对"最终即将上传"的 latest-mac.yml 再做一次独立校验(第二道护栏),
// 复用同一套断言逻辑,避免在 workflow YAML 里手写一遍容易写歪/漏改的校验。

import { readFileSync, writeFileSync } from "node:fs";
import yaml from "js-yaml";

const argv = process.argv.slice(2);
const flagVal = (name) => {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : undefined;
};

const isArm64Url = (url) => /-arm64\./.test(url);

const assertMultiArch = (files, label) => {
  const nonZip = files.filter((f) => !/\.zip$/.test(f.url));
  if (nonZip.length > 0) {
    console.error(
      `[merge-mac-update-manifest] 拒绝发布:${label} 含非 ZIP 条目 (${nonZip.map((f) => f.url).join(", ")})`,
    );
    process.exit(1);
  }
  const hasArm64 = files.some((f) => isArm64Url(f.url));
  const hasNonArm64 = files.some((f) => !isArm64Url(f.url));
  if (files.length < 2 || !hasArm64 || !hasNonArm64) {
    console.error(
      `[merge-mac-update-manifest] 拒绝发布:${label} 不是双架构 (files=${files.map((f) => f.url).join(", ")})`,
    );
    process.exit(1);
  }
};

const verifyPath = flagVal("--verify");
if (verifyPath) {
  const manifest = yaml.load(readFileSync(verifyPath, "utf-8"));
  assertMultiArch(manifest.files, verifyPath);
  console.log(`[merge-mac-update-manifest] ${verifyPath} 双架构校验通过: ${manifest.files.map((f) => f.url).join(", ")}`);
  process.exit(0);
}

const arm64Path = flagVal("--arm64");
const x64Path = flagVal("--x64");
const outPath = flagVal("--out");

if (!arm64Path || !x64Path || !outPath) {
  console.error(
    "用法: node scripts/merge-mac-update-manifest.mjs --arm64 <path> --x64 <path> --out <path>\n" +
      "  或: node scripts/merge-mac-update-manifest.mjs --verify <path>",
  );
  process.exit(1);
}

const arm64Manifest = yaml.load(readFileSync(arm64Path, "utf-8"));
const x64Manifest = yaml.load(readFileSync(x64Path, "utf-8"));

// ── 前置校验:两份清单各自必须"名副其实",版本必须一致 ─────────────────────────
if (arm64Manifest.version !== x64Manifest.version) {
  console.error(
    `[merge-mac-update-manifest] arm64(${arm64Manifest.version}) 与 x64(${x64Manifest.version}) 版本不一致,拒绝合并。`,
  );
  process.exit(1);
}
const armMismatch = arm64Manifest.files.filter((f) => !isArm64Url(f.url));
if (armMismatch.length > 0) {
  console.error(
    `[merge-mac-update-manifest] arm64 清单里混入了非 arm64 条目: ${armMismatch.map((f) => f.url).join(", ")}`,
  );
  process.exit(1);
}
const x64Mismatch = x64Manifest.files.filter((f) => isArm64Url(f.url));
if (x64Mismatch.length > 0) {
  console.error(
    `[merge-mac-update-manifest] x64 清单里混入了 arm64 条目: ${x64Mismatch.map((f) => f.url).join(", ")}`,
  );
  process.exit(1);
}

// ── 合并 files[](按 url 去重取并集)──────────────────────────────────────────
const byUrl = new Map();
for (const f of [...arm64Manifest.files, ...x64Manifest.files]) {
  byUrl.set(f.url, f);
}
const files = [...byUrl.values()];

// ── 后置校验:合并结果必须同时含 arm64 与非 arm64 条目 —— 这是防止事故重演的硬闸门 ──
assertMultiArch(files, "合并后的 latest-mac.yml");

// 顶层 path/sha512 兜底指向 arm64 的 zip:给理论上不按 files[] 过滤的老版本 updater 一个
// 安全默认(宁可默认拿到 arm64,不要重蹈"意外拿到 x64/Rosetta"的方向)。
const armZip = arm64Manifest.files.find((f) => /\.zip$/.test(f.url)) ?? arm64Manifest.files[0];

const merged = {
  version: arm64Manifest.version,
  files,
  path: armZip.url,
  sha512: armZip.sha512,
  releaseDate: arm64Manifest.releaseDate,
  releaseNotes: arm64Manifest.releaseNotes ?? x64Manifest.releaseNotes,
};

writeFileSync(outPath, yaml.dump(merged, { lineWidth: -1 }));
console.log(`[merge-mac-update-manifest] 已合并 → ${outPath}: ${files.map((f) => f.url).join(", ")}`);
