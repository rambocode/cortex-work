#!/usr/bin/env node
// 从 apps/desktop/CHANGELOG.md 提取「当前版本段」写入 apps/desktop/build/release-notes.md,
// 供 electron-builder（releaseInfo.releaseNotesFile,写进 latest-mac.yml 的 releaseNotes）
// 与 CI 的 `gh release --notes-file`（GitHub Release 页面）共用,保证应用内更新弹窗与
// release 页内容一致。运行时机:打包前(package.json 的 prebuild:notes,挂在 prepackage:mac
// 与各 dist:* 入口)。
//
// 版本键 = apps/desktop/package.json 的 version(裸版本号,无 v 前缀)。
// 标题格式契约:版本段标题须匹配 `^## \[?<version>\]?`,允许 `## [0.1.9]` / `## 0.1.9` /
//   `## [0.1.9] - 2026-06-20` 三种写法。
//
// 缺段语义分级:默认(本地/非正式构建)写安全占位并退出 0,不阻断;正式发布
//   (环境变量 CORTEX_NOTES_STRICT=1,由 CI publish-release 注入)则非零退出使 CI 失败,
//   强制发布者补 CHANGELOG,避免「忘写版本段 → 静默退化为永久占位」。

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const PLACEHOLDER = "本次更新暂无详细说明。";

// 转义正则元字符(版本号里的 `.`)。
function escapeRegExp(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// 纯函数(便于单测):从 changelog 文本提取 version 对应的版本段正文。
// 命中返回 trim 后的段落正文(不含标题行);未命中返回 null。
export function extractSection(changelog, version) {
  const escaped = escapeRegExp(version);
  // 标题行:## [version] / ## version / ## [version] - date;version 后不接数字或点,避免 0.1.8 误命中 0.1.80。
  const headingRe = new RegExp(`^##\\s+\\[?${escaped}\\]?(?![\\d.])`, "m");
  const match = headingRe.exec(changelog);
  if (!match) return null;
  const bodyStart = changelog.indexOf("\n", match.index);
  if (bodyStart === -1) return ""; // 标题是文件最后一行,正文为空
  const rest = changelog.slice(bodyStart + 1);
  // 正文截止到下一个二级标题(下一版本段)。
  const nextHeading = /^##\s+/m.exec(rest);
  const body = nextHeading ? rest.slice(0, nextHeading.index) : rest;
  return body.trim();
}

function main() {
  const here = dirname(fileURLToPath(import.meta.url));
  const desktopRoot = dirname(here); // apps/desktop
  const version = JSON.parse(readFileSync(join(desktopRoot, "package.json"), "utf-8")).version;
  const changelogPath = join(desktopRoot, "CHANGELOG.md");
  const outDir = join(desktopRoot, "build");
  const outPath = join(outDir, "release-notes.md");
  const strict = process.env.CORTEX_NOTES_STRICT === "1";
  const log = (msg) => console.log(`[extract-release-notes] ${msg}`);

  const changelog = existsSync(changelogPath) ? readFileSync(changelogPath, "utf-8") : "";
  const section = changelog ? extractSection(changelog, version) : null;

  if (section == null || section.length === 0) {
    const reason = changelog ? `CHANGELOG.md 无 ${version} 版本段` : "CHANGELOG.md 不存在";
    if (strict) {
      console.error(`[extract-release-notes] ${reason};正式发布要求补全 release notes,中止。`);
      process.exit(1);
    }
    mkdirSync(outDir, { recursive: true });
    writeFileSync(outPath, `${PLACEHOLDER}\n`, "utf-8");
    log(`${reason},写入占位 → ${outPath}`);
    return;
  }

  mkdirSync(outDir, { recursive: true });
  writeFileSync(outPath, `${section}\n`, "utf-8");
  log(`已写入 ${version} 版本段 → ${outPath}`);
}

// 仅直接运行时执行 IO;被测试 import 时不触发。
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main();
}
