// 发版前的「打 tag」自动化：收集提交素材 → 交 claude CLI 写发布说明草稿 → 人确认后写盘 + commit + tag。
//
// 为什么值得固化进控制台:这套动作每次发版都要做一遍,且有三条硬契约容易记错——
// CHANGELOG 版本段标题必须匹配 extract-release-notes.mjs 的正则(否则 CI 发布时拿不到更新说明)、
// commit message 固定 `chore(release): v<version>`、发版 commit 只应含 package.json + CHANGELOG.md
// 两个文件。写作部分交给 claude,契约校验部分交给代码,人只负责审阅措辞。
//
// 与 steps.mjs 的关系:这里不是发布流水线的阶段,不进 run.steps 状态机(否则会污染
// .release-stage/<tag>.state.json 的续跑进度),只借 run.log 把过程打进同一条实时日志。

import fs from "node:fs";
import path from "node:path";

const CHANGELOG_REL = "apps/desktop/CHANGELOG.md";
const PKG_REL = "apps/desktop/package.json";

// claude 生成一段发布说明通常几十秒;给 5 分钟兜底,避免 CLI 卡死时端点永不返回。
const CLAUDE_TIMEOUT_MS = 5 * 60 * 1000;
// prompt 素材上限。git log 正文是主要输入,超长时截断而不是整段丢弃——
// 发布说明的价值集中在提交标题与 What/Why 段,尾部截掉几条也不至于失真。
const MAX_COMMITS_CHARS = 60_000;
const MAX_STAT_CHARS = 20_000;

/** patch 位 +1。非三段式版本号原样返回，交由调用方的格式校验拦下。 */
export function nextPatchVersion(version) {
  const m = /^(\d+)\.(\d+)\.(\d+)/.exec(version ?? "");
  if (!m) return version ?? "";
  return `${m[1]}.${m[2]}.${Number(m[3]) + 1}`;
}

/** 版本号格式:三段式,允许 -beta.1 之类后缀(CI 与 electron-builder 都按 semver 处理)。 */
export function isValidVersion(v) {
  return /^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/.test(v ?? "");
}

function clip(text, max, label) {
  if (text.length <= max) return text;
  return `${text.slice(0, max)}\n\n…（${label}过长，已截断，省略 ${text.length - max} 字符）`;
}

/** 取 CHANGELOG 里最近 n 个版本段原文，作为给 claude 的写作风格样例。 */
function recentChangelogSections(repoRoot, n = 2) {
  const file = path.join(repoRoot, CHANGELOG_REL);
  if (!fs.existsSync(file)) return "";
  const text = fs.readFileSync(file, "utf8");
  const parts = text.split(/^## /m).slice(1, 1 + n);
  return parts.map((p) => `## ${p.trim()}`).join("\n\n");
}

/**
 * 收集喂给 claude 的原始素材：上一个 tag 起的提交标题+正文、文件改动统计、既有版本段样例。
 * 全部由本进程用 git 取好塞进 prompt,claude 因此不需要任何工具权限(纯文本进纯文本出)。
 */
export async function collectReleaseInput({ repoRoot, run }) {
  const prev = await run.capture("git", ["describe", "--tags", "--abbrev=0"], { cwd: repoRoot });
  if (!prev.ok || !prev.stdout) throw new Error("找不到上一个 tag（git describe --tags --abbrev=0 失败）");
  const prevTag = prev.stdout;
  const range = `${prevTag}..HEAD`;

  const countRes = await run.capture("git", ["rev-list", "--count", "--no-merges", range], { cwd: repoRoot });
  const commitCount = Number(countRes.stdout || 0);
  if (!commitCount) throw new Error(`${prevTag} 之后没有新提交，无需发版`);

  const logRes = await run.capture("git", ["log", range, "--no-merges", "--format==== %h %s%n%b"], { cwd: repoRoot });
  if (!logRes.ok) throw new Error(`读取提交历史失败：${logRes.stderr}`);

  const statRes = await run.capture("git", ["log", range, "--no-merges", "--stat", "--format=--- %h %s"], { cwd: repoRoot });

  return {
    prevTag,
    commitCount,
    commits: clip(logRes.stdout, MAX_COMMITS_CHARS, "提交正文"),
    stat: clip(statRes.ok ? statRes.stdout : "", MAX_STAT_CHARS, "改动统计"),
    styleSample: recentChangelogSections(repoRoot, 2),
  };
}

/** 拼 prompt。写作规范与 CLAUDE.md 的发版约定、CHANGELOG.md 头部的格式契约注释保持一致。 */
function buildPrompt({ input, version }) {
  return `你在为 macOS 桌面应用 Cortex 撰写 v${version} 的更新日志正文（面向普通用户，中文简体）。

# 写作规范
- 读完下面 ${input.prevTag} 之后的**全部**提交（不是只看最近一条），按用户能感知的变化归纳。
- 面向用户描述「变化是什么、对我有什么影响」，不要罗列内部实现、文件名、函数名、commit hash。
- 跳过纯内部改动：重构、目录整理、依赖升级、CI/构建脚本、测试、代码审查修复（除非它修的是用户能撞见的 bug）。
- 同类改动合并成一条，不要一个提交一条。重要程度高的排前面，修复类排后面。
- 每条格式固定为：\`- **小标题**：一到三句正文。\`（小标题 2-8 个字，用粗体）
- 总条数控制在 4-9 条。不要写空话（如「优化了体验」），要写具体变化。
- 只输出这些条目本身。**不要**输出 \`## [${version}]\` 标题行、不要代码块包裹、不要任何前后解释。
- 不要使用任何工具，直接输出正文。

# 既有版本段（照此风格与粒度写）
${input.styleSample || "（无）"}

# 本次提交（${input.prevTag}..HEAD，共 ${input.commitCount} 条）
${input.commits}

# 文件改动统计
${input.stat || "（无）"}
`;
}

/** 清洗 claude 输出：剥掉可能出现的代码块包裹、版本标题行与开场白，只留条目正文。 */
function cleanNotes(raw) {
  let text = (raw ?? "").trim();
  const fence = /^```(?:markdown|md)?\s*\n([\s\S]*?)\n```$/.exec(text);
  if (fence) text = fence[1].trim();
  const lines = text.split("\n");
  // 首个以 - / * 开头的行之前的内容一律丢弃(版本标题行、"好的，以下是…" 之类开场白)。
  const start = lines.findIndex((l) => /^\s*[-*]\s/.test(l));
  if (start > 0) lines.splice(0, start);
  return lines.join("\n").trim();
}

/**
 * 调 claude CLI 生成发布说明草稿。prompt 走 stdin（含 git log 全文，argv 有长度上限）。
 * 显式禁用全部工具:素材已在 prompt 里,放开工具只会让它去翻仓库,既慢又可能改到文件。
 */
export async function draftReleaseNotes({ repoRoot, run, input, version, env = process.env }) {
  const bin = env.CLAUDE_BIN || "claude";
  const prompt = buildPrompt({ input, version });
  run.log(`调用 ${bin} 生成 v${version} 发布说明（素材 ${prompt.length} 字符 / ${input.commitCount} 条提交，最长等 5 分钟）…`, "cmd");
  const started = Date.now();
  const res = await run.capture(
    bin,
    [
      "-p",
      "--output-format",
      "text",
      "--no-session-persistence",
      "--disallowed-tools",
      "Bash,Read,Edit,Write,Glob,Grep,WebFetch,WebSearch,Task",
    ],
    { cwd: repoRoot, env, stdin: prompt, timeoutMs: CLAUDE_TIMEOUT_MS },
  );
  const cost = Math.round((Date.now() - started) / 1000);
  if (res.code === -1 && res.stderr === "spawn failed") {
    throw new Error(`找不到 claude 命令（可用环境变量 CLAUDE_BIN 指定绝对路径后重启发布控制台）`);
  }
  if (!res.ok) throw new Error(`claude 生成失败（${cost}s）：${res.stderr || `退出码 ${res.code}`}`);
  const notes = cleanNotes(res.stdout);
  if (!notes) throw new Error(`claude 返回了空内容（${cost}s）`);
  run.log(`✓ 发布说明草稿已生成（${cost}s，${notes.split("\n").filter((l) => l.trim()).length} 行）`, "ok");
  return notes;
}

/** https 形式的 GitHub remote 转 SSH。导出以便单独验证（推送路径不适合在真实仓库上试错）。 */
export function toSshUrl(url) {
  const https = /^https:\/\/github\.com\/(.+?)(?:\.git)?$/.exec(url);
  if (https) return `git@github.com:${https[1]}.git`;
  const sshProto = /^ssh:\/\/git@github\.com\/(.+?)(?:\.git)?$/.exec(url);
  if (sshProto) return `git@github.com:${sshProto[1]}.git`;
  return url; // 已是 git@github.com:owner/repo.git 形式
}

/** 只替换 package.json 里第一个 version 字段，保留文件原有格式（不整体重写 JSON）。 */
function bumpPackageVersion(file, oldVersion, newVersion) {
  const text = fs.readFileSync(file, "utf8");
  const re = /("version"\s*:\s*")([^"]+)(")/;
  const m = re.exec(text);
  if (!m || m[2] !== oldVersion) throw new Error(`${PKG_REL} 里的 version 字段与预期不符（读到 ${m?.[2]}，期望 ${oldVersion}）`);
  fs.writeFileSync(file, text.replace(re, `$1${newVersion}$3`));
}

/**
 * 在 `# 更新日志` 标题之后插入新版本段。
 * 锚点正则用 `[^\n]*\n` 而不是 `\s*$`:后者的 `\s` 会连标题后的空行一起吃掉，
 * 插入结果会多出一个空行（实测），改成只吃到标题行末的换行符，空行数由这里显式控制。
 */
function insertChangelogSection(file, version, notes) {
  const text = fs.readFileSync(file, "utf8");
  const anchor = /^# 更新日志[^\n]*\n/m.exec(text);
  if (!anchor) throw new Error(`${CHANGELOG_REL} 里找不到「# 更新日志」标题，无法定位插入点`);
  const d = new Date();
  const date = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  const section = `## [${version}] - ${date}\n\n${notes.trim()}\n`;
  const at = anchor.index + anchor[0].length;
  const rest = text.slice(at).replace(/^\n+/, "");
  fs.writeFileSync(file, `${text.slice(0, at)}\n${section}\n${rest}`);
  return date;
}

/**
 * 落盘 + commit + tag（可选推送）。任何一步失败都直接抛，前面已写的文件留在工作区供人修。
 *
 * 顺序上把「格式契约实测」放在 commit 之前:extract-release-notes.mjs 是 CI 发布时真正会跑的
 * 那个脚本,它跑不过就等于这次发版的更新说明是空的,此时还没 commit,改起来没有历史包袱。
 */
export async function applyTag({ repoRoot, run, version, notes, push = false, env = process.env }) {
  if (!isValidVersion(version)) throw new Error(`版本号格式不对：${version}`);
  if (!notes?.trim()) throw new Error("发布说明为空");
  const tag = `v${version}`;

  // 发版 commit 只应含 package.json + CHANGELOG.md 两个文件,工作区有别的改动就会被 git add 之外
  // 的人为误操作夹带;宁可让人先自己处理干净。
  const dirty = await run.capture("git", ["status", "--porcelain"], { cwd: repoRoot });
  const dirtyFiles = dirty.stdout ? dirty.stdout.split("\n").filter((l) => l.trim() && !l.startsWith("??")) : [];
  if (dirtyFiles.length) {
    throw new Error(`工作区有 ${dirtyFiles.length} 个未提交改动，先处理干净再打 tag：\n${dirtyFiles.join("\n")}`);
  }

  const existing = await run.capture("git", ["rev-parse", "--verify", `refs/tags/${tag}`], { cwd: repoRoot });
  if (existing.ok) throw new Error(`${tag} 已存在（指向 ${existing.stdout.slice(0, 8)}），换个版本号或先删除该 tag`);

  const pkgFile = path.join(repoRoot, PKG_REL);
  const changelogFile = path.join(repoRoot, CHANGELOG_REL);
  const currentVersion = JSON.parse(fs.readFileSync(pkgFile, "utf8")).version;
  const changelogText = fs.readFileSync(changelogFile, "utf8");
  if (new RegExp(`^##\\s*\\[?${version.replace(/\./g, "\\.")}\\]?`, "m").test(changelogText)) {
    throw new Error(`CHANGELOG.md 里已存在 ${version} 版本段，不重复插入`);
  }

  if (currentVersion !== version) {
    bumpPackageVersion(pkgFile, currentVersion, version);
    run.log(`✓ ${PKG_REL}：${currentVersion} → ${version}`, "ok");
  } else {
    run.log(`${PKG_REL} 已是 ${version}，跳过 bump`, "skip");
  }
  const date = insertChangelogSection(changelogFile, version, notes);
  run.log(`✓ ${CHANGELOG_REL}：已插入 ## [${version}] - ${date}`, "ok");

  // CI 发布时真正取更新说明的脚本，严格模式下缺段/空段直接非零退出。
  await run.exec("node", ["apps/desktop/scripts/extract-release-notes.mjs"], {
    cwd: repoRoot,
    env: { ...env, CORTEX_NOTES_STRICT: "1" },
  });

  await run.exec("git", ["add", PKG_REL, CHANGELOG_REL], { cwd: repoRoot });
  await run.exec("git", ["commit", "-m", `chore(release): ${tag}`], { cwd: repoRoot });
  await run.exec("git", ["tag", tag], { cwd: repoRoot });
  run.log(`✓ 已提交并打 tag ${tag}`, "ok");

  let pushed = false;
  if (push) {
    const branchRes = await run.capture("git", ["rev-parse", "--abbrev-ref", "HEAD"], { cwd: repoRoot });
    const branch = branchRes.stdout;
    if (!branchRes.ok || !branch || branch === "HEAD") throw new Error("当前处于游离 HEAD，拒绝推送");
    const remoteRes = await run.capture("git", ["remote", "get-url", "origin"], { cwd: repoRoot });
    if (!remoteRes.ok) throw new Error("读不到 origin 远端地址");
    // 必须走 SSH:本仓库的 gh OAuth token 缺 workflow scope,https 推送一旦带上
    // .github/workflows 下的改动会被 GitHub 直接拒绝(实测)。
    const sshUrl = toSshUrl(remoteRes.stdout);
    await run.exec("git", ["push", sshUrl, `${branch}:${branch}`], { cwd: repoRoot });
    await run.exec("git", ["push", sshUrl, tag], { cwd: repoRoot });
    // 上一步绕开了 origin 这个 remote 名，本地的 origin/* 引用不会自动前进，补一次 fetch。
    await run.capture("git", ["fetch", "origin", "--tags"], { cwd: repoRoot });
    pushed = true;
    run.log(`✓ 已推送 ${branch} 与 ${tag} 到 origin`, "ok");
  }

  return { version, tag, pushed };
}
