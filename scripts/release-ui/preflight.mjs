// 发版前置校验。把 local-release-mac.sh 开头那几条 `exit 1` 的检查,连同 CLAUDE.md 里
// 「发版必须先写 CHANGELOG 版本段」的硬规矩,一次性摊在界面上。
//
// 为什么要提前全量检查而不是边跑边报错:双架构构建+公证一轮要 20 分钟以上,把「tag 忘了打」
// 「CHANGELOG 忘了写」这种一秒就能查出来的事留到最后一步才炸,代价完全不成比例。

import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";

function run(cmd, args, cwd) {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { cwd, stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    let err = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (err += d));
    child.on("error", () => resolve({ ok: false, stdout: "", stderr: "命令不可用" }));
    child.on("close", (code) => resolve({ ok: code === 0, stdout: out.trim(), stderr: err.trim() }));
  });
}

/** 读 CHANGELOG 里是否存在当前版本段。正则与 extract-release-notes.mjs 的格式契约保持一致。 */
function hasChangelogSection(repoRoot, version) {
  const file = path.join(repoRoot, "apps/desktop/CHANGELOG.md");
  if (!fs.existsSync(file)) return { ok: false, detail: "找不到 apps/desktop/CHANGELOG.md" };
  const text = fs.readFileSync(file, "utf8");
  const escaped = version.replace(/\./g, "\\.");
  const re = new RegExp(`^##\\s*\\[?${escaped}\\]?`, "m");
  if (!re.test(text)) {
    return { ok: false, detail: `CHANGELOG.md 顶部缺 ## [${version}] 版本段——CI 会因此发布失败` };
  }
  // 顺带量一下正文长度：只有标题没正文同样等于丢更新说明。
  const body = text.split(re)[1]?.split(/^## /m)[0]?.trim() ?? "";
  if (body.length < 10) return { ok: false, detail: `${version} 版本段正文为空` };
  return { ok: true, detail: `${version} 版本段就绪（${body.split("\n").filter((l) => l.trim()).length} 条）` };
}

/**
 * 跑齐所有前置检查。level:
 *   error — 必须解决，否则发布注定失败；warn — 可以带病发布，但要用户知情。
 */
export async function runPreflight({ repoRoot, version, tag, creds }) {
  const checks = [];
  const add = (name, ok, detail, level = "error") => checks.push({ name, ok, detail, level });

  add(...(() => {
    const r = hasChangelogSection(repoRoot, version);
    return ["CHANGELOG 版本段", r.ok, r.detail];
  })());

  const dirty = await run("git", ["status", "--porcelain"], repoRoot);
  const dirtyFiles = dirty.stdout ? dirty.stdout.split("\n").filter(Boolean) : [];
  add(
    "工作区干净",
    dirtyFiles.length === 0,
    dirtyFiles.length === 0 ? "无未提交改动" : `${dirtyFiles.length} 个文件未提交（产物仍会按已提交内容构建）`,
    "warn",
  );

  const localTag = await run("git", ["rev-parse", "--verify", `refs/tags/${tag}`], repoRoot);
  add("本地 tag", localTag.ok, localTag.ok ? `${tag} → ${localTag.stdout.slice(0, 8)}` : `本地没有 ${tag}，需先打 tag`);

  if (localTag.ok) {
    const head = await run("git", ["rev-parse", "HEAD"], repoRoot);
    add(
      "tag 指向 HEAD",
      head.stdout === localTag.stdout,
      head.stdout === localTag.stdout ? "一致" : `${tag} 未指向当前 HEAD，产物与 tag 内容会对不上`,
      "warn",
    );
    const remoteTag = await run("git", ["ls-remote", "--tags", "origin", `refs/tags/${tag}`], repoRoot);
    add(
      "tag 已推送",
      Boolean(remoteTag.stdout),
      remoteTag.stdout ? "origin 上已有该 tag" : `${tag} 尚未推送到 origin`,
      "warn",
    );
  }

  const cert = await run("security", ["find-identity", "-v", "-p", "codesigning"], repoRoot);
  const hasCert = cert.stdout.includes("HQ537XMLJY");
  add("签名证书", hasCert, hasCert ? "钥匙串中已找到 Developer ID（HQ537XMLJY）" : "钥匙串未找到 Developer ID 证书");

  const ghToken = await run("gh", ["auth", "token"], repoRoot);
  add("gh 登录", ghToken.ok, ghToken.ok ? "已登录，可发布到 release 仓库" : "gh 未登录且未设 GH_TOKEN");

  const credOk = Boolean(creds.keychainProfile || (creds.appleId && creds.appPassword));
  add(
    "Apple 公证凭据",
    credOk,
    credOk
      ? creds.keychainProfile
        ? `使用钥匙串 profile：${creds.keychainProfile}`
        : `使用 Apple ID：${creds.appleId}`
      : ".env 缺 APPLE_ID / APPLE_APP_SPECIFIC_PASSWORD",
  );

  const blocking = checks.filter((c) => !c.ok && c.level === "error");
  return { checks, canRelease: blocking.length === 0 };
}
