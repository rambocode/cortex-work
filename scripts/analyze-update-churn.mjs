#!/usr/bin/env node
// 自动更新差量归因分析:对比相邻两个 release 的 macOS zip,逐文件找出「哪些文件贡献了
// 多少差量字节」。一次性诊断工具,不进 CI。
//
// 为什么需要它:electron-builder 给 mac zip 生成的 blockmap 只有一个整体 "file" 条目
// (块级内容定义分块,无文件粒度),只能算出差量总量,无法定位 churn 来源。要归因就必须
// 下载两版 zip 解包,逐文件对比哈希——这正是本脚本做的事。
//
// 用法:
//   node scripts/analyze-update-churn.mjs [--from v0.1.48] [--to v0.1.49] [--arch arm64|x64]
//     [--repo rambocode/cortex-work-release] [--asar] [--top 30] [--keep]
//   缺省 --from/--to 取仓库最近两个 release;--asar 额外解开 app.asar 归因内部文件;
//   --keep 保留临时目录便于人工检查。
//
// 仅支持 macOS zip(解压用 ditto,win 产物是 nsis 另一套格式,不在范围)。依赖 gh CLI 已登录。

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream, lstatSync, mkdtempSync, readdirSync, readlinkSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = dirname(here);

// ── CLI 参数 ─────────────────────────────────────────────────────────────────
const argv = process.argv.slice(2);
const flagVal = (name, dflt) => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : dflt; };
const has = (name) => argv.includes(name);
const repo = flagVal("--repo", "rambocode/cortex-work-release");
const arch = flagVal("--arch", "arm64");
const topN = Number(flagVal("--top", "30"));
const wantAsar = has("--asar");
const keep = has("--keep");

const mb = (n) => `${(n / 1e6).toFixed(1)} MB`;

// 缺省版本:取仓库最近两个 release tag(gh 按时间倒序返回)。
function latestTwoTags() {
  const out = execFileSync("gh", ["release", "list", "--repo", repo, "--limit", "2", "--json", "tagName", "--jq", ".[].tagName"], { encoding: "utf-8" });
  const tags = out.trim().split("\n").filter(Boolean);
  if (tags.length < 2) throw new Error(`仓库 ${repo} 的 release 不足两个,请显式传 --from/--to`);
  return { from: tags[1], to: tags[0] };
}

const dflt = flagVal("--from") && flagVal("--to") ? null : latestTwoTags();
const fromTag = flagVal("--from", dflt?.from);
const toTag = flagVal("--to", dflt?.to);

// ── 下载与解压 ───────────────────────────────────────────────────────────────
function downloadZip(tag, dir) {
  console.log(`下载 ${tag} 的 ${arch} zip …`);
  execFileSync("gh", ["release", "download", tag, "--repo", repo, "--pattern", `*-${arch}.zip`, "-D", dir], { stdio: "inherit" });
  const zip = readdirSync(dir).find((f) => f.endsWith(".zip"));
  if (!zip) throw new Error(`${tag} 下载后未找到 zip`);
  return join(dir, zip);
}

// zip 内是 .app(含 symlink 与 Framework 目录链接),unzip 会破坏链接结构,必须用 ditto。
function extractZip(zipPath, destDir) {
  execFileSync("ditto", ["-x", "-k", zipPath, destDir], { stdio: "inherit" });
}

// ── 遍历与对比 ───────────────────────────────────────────────────────────────
function sha256(file) {
  return new Promise((resolve, reject) => {
    const h = createHash("sha256");
    createReadStream(file).on("data", (d) => h.update(d)).on("end", () => resolve(h.digest("hex"))).on("error", reject);
  });
}

// 递归收集 Map<relPath, {size, sha} | {link}>。symlink 只记 target 不哈希(链接目标
// 在树内会被自身条目覆盖,树外则内容不属于更新包)。
async function walkTree(root) {
  const entries = new Map();
  async function walk(dir) {
    for (const name of readdirSync(dir)) {
      const p = join(dir, name);
      const st = lstatSync(p);
      const rel = relative(root, p);
      if (st.isSymbolicLink()) entries.set(rel, { link: readlinkSync(p) });
      else if (st.isDirectory()) await walk(p);
      else entries.set(rel, { size: st.size, sha: await sha256(p) });
    }
  }
  await walk(root);
  return entries;
}

// 逐 relPath 对比两棵树:changed/added 的 newSize 之和即「理论最小重传字节」。
function diffTrees(oldMap, newMap) {
  const changed = [], added = [], removed = [];
  let sameBytes = 0, sameCount = 0;
  for (const [rel, e] of newMap) {
    const o = oldMap.get(rel);
    if (!o) { if (e.size != null) added.push({ rel, newSize: e.size }); continue; }
    if (e.link != null || o.link != null) { if (e.link !== o.link) changed.push({ rel, newSize: 0, oldSize: 0 }); continue; }
    if (e.sha === o.sha) { sameBytes += e.size; sameCount += 1; }
    else changed.push({ rel, newSize: e.size, oldSize: o.size });
  }
  for (const rel of oldMap.keys()) if (!newMap.has(rel)) removed.push(rel);
  return { changed, added, removed, sameBytes, sameCount };
}

function report(title, diff, newMap) {
  const churn = [...diff.changed, ...diff.added].sort((a, b) => b.newSize - a.newSize);
  const churnBytes = churn.reduce((s, c) => s + c.newSize, 0);
  const totalBytes = [...newMap.values()].reduce((s, e) => s + (e.size ?? 0), 0);
  console.log(`\n== ${title} ==`);
  console.log(
    `总文件: ${newMap.size} | 未变: ${diff.sameCount} (${mb(diff.sameBytes)}) | ` +
    `变化: ${diff.changed.length} | 新增: ${diff.added.length} | 删除: ${diff.removed.length}`,
  );
  console.log(`理论最小重传: ${mb(churnBytes)} / 解包总量 ${mb(totalBytes)} (${((churnBytes / totalBytes) * 100).toFixed(1)}%)`);
  console.log(`\n变化字节 Top ${Math.min(topN, churn.length)}:`);
  for (const c of churn.slice(0, topN)) {
    const tag = c.oldSize == null ? "  [新增]" : "";
    console.log(`  ${mb(c.newSize).padStart(9)}  ${c.rel}${tag}`);
  }
  return churn;
}

// ── 主流程 ───────────────────────────────────────────────────────────────────
const work = mkdtempSync(join(tmpdir(), "cortex-churn-"));
console.log(`工作目录: ${work}${keep ? "(--keep 保留)" : ""}`);

try {
  const dirs = {};
  for (const [key, tag] of [["old", fromTag], ["new", toTag]]) {
    const d = join(work, key);
    const zip = downloadZip(tag, d);
    const app = join(d, "app");
    console.log(`解压 ${tag} …`);
    extractZip(zip, app);
    dirs[key] = app;
  }

  console.log("逐文件哈希对比 …");
  const [oldMap, newMap] = await Promise.all([walkTree(dirs.old), walkTree(dirs.new)]);
  const diff = diffTrees(oldMap, newMap);
  const churn = report(`Cortex ${fromTag} → ${toTag} (${arch}) 更新 churn 分析`, diff, newMap);

  // --asar:把变化的 *.asar 解开,归因到 asar 内部文件(app.asar 通常是最大 churn 源)。
  if (wantAsar) {
    const req = createRequire(join(repoRoot, "apps/desktop/package.json"));
    const asar = req("@electron/asar");
    for (const c of churn.filter((c) => c.rel.endsWith(".asar") && c.oldSize != null)) {
      const oldOut = join(work, "asar-old"), newOut = join(work, "asar-new");
      rmSync(oldOut, { recursive: true, force: true });
      rmSync(newOut, { recursive: true, force: true });
      asar.extractAll(join(dirs.old, c.rel), oldOut);
      asar.extractAll(join(dirs.new, c.rel), newOut);
      const [ao, an] = await Promise.all([walkTree(oldOut), walkTree(newOut)]);
      report(`↳ ${c.rel} 内部归因`, diffTrees(ao, an), an);
    }
  }
} finally {
  if (!keep) rmSync(work, { recursive: true, force: true });
}
