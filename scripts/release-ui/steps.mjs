// macOS 双架构发布流程的阶段定义。逐条对应 scripts/local-release-mac.sh，语义必须保持一致。
//
// 【顺序为什么不能动】两个架构必须串行:apps/desktop/scripts/build-pi-binary.mjs 的输出目录
// resources/pi/ 是单一共享目录,每次重建清空重写,两架构的 pi 二进制无法并存。因此只能
// 「建 arm64 → 打包 → 把产物拷走 → 建 x64 → 打包」。x64 的 prepackage 一旦跑起来,
// dist 里的 arm64 产物就不再可信——所以 arm64:stage 必须在 x64:prepackage 之前完成。
//
// 【发布为什么只做一次】合并两份 latest-mac.yml 后一次性上传。分两次传会出现「后一个架构的
// 清单覆盖前一个」,这正是 v0.1.27 发布事故的根源。

import fs from "node:fs";
import path from "node:path";
import os from "node:os";

const PRODUCT = "Cortex";
const REPO = "rambocode/cortex-work-release";
const CSC_NAME = "Jiangwei Lan (HQ537XMLJY)";

/** 在目录里按后缀找文件（替代 bash 的 glob）。 */
function findFiles(dir, predicate) {
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter(predicate)
    .map((f) => path.join(dir, f));
}

/** 复制若干文件到暂存目录，缺任何一个都直接失败——宁可现在报，也不要传上去才发现少产物。 */
function copyAll(files, destDir, label) {
  if (!files.length) throw new Error(`找不到${label}产物`);
  fs.mkdirSync(destDir, { recursive: true });
  for (const f of files) fs.copyFileSync(f, path.join(destDir, path.basename(f)));
  return files.map((f) => path.basename(f));
}

/**
 * 校验已签名的 .app 与 dmg。
 * 刻意先 ditto 到临时目录再验:直接对 dist 里的 app 跑 spctl 会因为 quarantine 属性缺失而
 * 与用户真实下载到的产物状态不一致,ditto 一次能还原「解压后」的样子。
 */
async function verifySigned(run, appDir, dmgSuffix) {
  const work = fs.mkdtempSync(path.join(os.tmpdir(), "cortex-verify-"));
  const appPath = path.join(appDir, `${PRODUCT}.app`);
  if (!fs.existsSync(appPath)) throw new Error(`找不到已签名的 app：${appPath}`);

  await run.exec("ditto", [appPath, path.join(work, `${PRODUCT}.app`)]);
  await run.exec("codesign", ["--verify", "--deep", "--strict", "--verbose=2", path.join(work, `${PRODUCT}.app`)]);
  await run.exec("spctl", ["--assess", "--type", "execute", "--verbose", path.join(work, `${PRODUCT}.app`)]);
  await run.exec("xcrun", ["stapler", "validate", path.join(work, `${PRODUCT}.app`)]);

  const dmg = findFiles(path.dirname(appDir), (f) => f.endsWith(dmgSuffix))[0];
  if (dmg) {
    const dmgCopy = path.join(work, path.basename(dmg));
    fs.copyFileSync(dmg, dmgCopy);
    // dmg 自身没有独立签名/ticket 是可接受的:Gatekeeper 认的是挂载后 app 上的 ticket。
    const a = await run.capture("spctl", ["--assess", "--type", "open", "--context", "context:primary-signature", "--verbose", dmgCopy]);
    if (!a.ok) run.log("DMG 无独立代码签名/公证 — 可接受(挂载后 app 已公证,Gatekeeper 认 app)。", "warn");
    const b = await run.capture("xcrun", ["stapler", "validate", dmgCopy]);
    if (!b.ok) run.log("DMG 无 stapled ticket — 可接受(app ticket 已 staple)。", "warn");
  }
  fs.rmSync(work, { recursive: true, force: true });
  run.log(`✓ 签名+公证+staple 校验通过(${appDir})`, "ok");
}

/**
 * 构造阶段列表。每个阶段 { id, title, group, run(ctx) }。
 * ctx: { run, repoRoot, tag, version, stageDir, env }
 */
export function buildSteps() {
  const pnpmDesktop = (script, extraEnv = {}) => async (ctx) => {
    await ctx.run.exec("pnpm", ["--filter", "@cortex-work/desktop", "run", script], {
      env: { ...ctx.env, ...extraEnv },
    });
  };

  return [
    {
      id: "clean",
      group: "准备",
      title: "清理旧产物 + 准备暂存目录",
      run: async (ctx) => {
        // 本地 dist 里残留的旧版本 dmg/zip 会被后面的产物收集误匹配并传到 release
        // （CI 在干净 VM 上无此问题，本地必须先清一次）。
        const dist = path.join(ctx.repoRoot, "apps/desktop/dist");
        fs.rmSync(dist, { recursive: true, force: true });
        ctx.run.log(`已清理 ${dist}`, "ok");
        fs.mkdirSync(ctx.stageDir, { recursive: true });
        ctx.run.log(`暂存目录：${ctx.stageDir}`, "ok");
      },
    },
    {
      id: "arm64:prepackage",
      group: "macOS arm64",
      title: "预构建（release notes / pi / helper / whisper / renderer）",
      // CORTEX_NOTES_STRICT=1:CHANGELOG 缺版本段时直接失败,而不是写个占位悄悄放过去。
      run: pnpmDesktop("prepackage:mac-arm64", { CORTEX_NOTES_STRICT: "1" }),
    },
    {
      id: "arm64:build",
      group: "macOS arm64",
      title: "打包 + 签名 + 公证（zip/dmg）",
      run: pnpmDesktop("build:mac-arm64", { CSC_NAME }),
    },
    {
      id: "arm64:verify",
      group: "macOS arm64",
      title: "校验签名 / 公证 / staple",
      run: async (ctx) => verifySigned(ctx.run, path.join(ctx.repoRoot, "apps/desktop/dist/mac-arm64"), "-arm64.dmg"),
    },
    {
      id: "arm64:stage",
      group: "macOS arm64",
      title: "产物存入暂存目录",
      run: async (ctx) => {
        const dist = path.join(ctx.repoRoot, "apps/desktop/dist");
        const picked = copyAll(
          findFiles(dist, (f) => /-arm64\.(dmg|zip)(\.blockmap)?$/.test(f)),
          ctx.stageDir,
          "arm64",
        );
        // per-arch 清单先按架构改名存着，最后一步才合并——绝不单独上传。
        fs.copyFileSync(path.join(dist, "latest-mac.yml"), path.join(ctx.stageDir, "latest-mac-arm64.yml"));
        // release-notes.md 由 prepackage 生成，x64 会重跑覆盖，这里先留一份给发布阶段用。
        fs.cpSync(path.join(ctx.repoRoot, "apps/desktop/build"), path.join(ctx.stageDir, "build"), { recursive: true });
        ctx.run.log(`已暂存：${picked.join(", ")} + latest-mac-arm64.yml`, "ok");
      },
    },
    {
      id: "x64:prepackage",
      group: "macOS x64",
      title: "预构建（会覆盖 arm64 的 pi 二进制）",
      run: pnpmDesktop("prepackage:mac-x64", { CORTEX_NOTES_STRICT: "1" }),
    },
    {
      id: "x64:build",
      group: "macOS x64",
      title: "打包 + 签名 + 公证（zip/dmg）",
      run: pnpmDesktop("build:mac-x64", { CSC_NAME }),
    },
    {
      id: "x64:verify",
      group: "macOS x64",
      title: "校验签名 / 公证 / staple",
      run: async (ctx) => verifySigned(ctx.run, path.join(ctx.repoRoot, "apps/desktop/dist/mac"), "-x64.dmg"),
    },
    {
      id: "x64:stage",
      group: "macOS x64",
      title: "产物存入暂存目录",
      run: async (ctx) => {
        const dist = path.join(ctx.repoRoot, "apps/desktop/dist");
        const picked = copyAll(
          findFiles(dist, (f) => /-x64\.(dmg|zip)(\.blockmap)?$/.test(f)),
          ctx.stageDir,
          "x64",
        );
        fs.copyFileSync(path.join(dist, "latest-mac.yml"), path.join(ctx.stageDir, "latest-mac-x64.yml"));
        ctx.run.log(`已暂存：${picked.join(", ")} + latest-mac-x64.yml`, "ok");
      },
    },
    {
      id: "manifest",
      group: "发布",
      title: "合并双架构更新清单 + 双重护栏",
      run: async (ctx) => {
        const script = "apps/desktop/scripts/merge-mac-update-manifest.mjs";
        const out = path.join(ctx.stageDir, "latest-mac.yml");
        await ctx.run.exec("node", [
          script,
          "--arm64", path.join(ctx.stageDir, "latest-mac-arm64.yml"),
          "--x64", path.join(ctx.stageDir, "latest-mac-x64.yml"),
          "--out", out,
        ]);
        await ctx.run.exec("node", [script, "--verify", out]);
        // per-arch 中间清单绝不上传，合并后即删，杜绝「误传单架构清单」的可能。
        for (const f of ["latest-mac-arm64.yml", "latest-mac-x64.yml"]) {
          fs.rmSync(path.join(ctx.stageDir, f), { force: true });
        }
        ctx.run.log("✓ 清单已合并并通过校验，per-arch 中间清单已删除", "ok");
      },
    },
    {
      id: "publish",
      group: "发布",
      title: `上传到 ${REPO}`,
      run: async (ctx) => {
        const tokenRes = await ctx.run.capture("gh", ["auth", "token"]);
        const token = process.env.GH_TOKEN || (tokenRes.ok ? tokenRes.stdout : "");
        if (!token) throw new Error("gh 未登录且未设 GH_TOKEN");
        const env = { ...ctx.env, GH_TOKEN: token };

        // release 仓库里没有该 tag ref 时先建一个：产物仓与源码仓是两个 repo，tag 不会自动同步。
        const refExists = await ctx.run.capture("gh", ["api", `repos/${REPO}/git/ref/tags/${ctx.tag}`], { env });
        if (!refExists.ok) {
          const branch = await ctx.run.capture("gh", ["repo", "view", REPO, "--json", "defaultBranchRef", "--jq", ".defaultBranchRef.name"], { env });
          const sha = await ctx.run.capture("gh", ["api", `repos/${REPO}/commits/${branch.stdout}`, "--jq", ".sha"], { env });
          await ctx.run.exec("gh", ["api", "--method", "POST", `repos/${REPO}/git/refs`, "-f", `ref=refs/tags/${ctx.tag}`, "-f", `sha=${sha.stdout}`], { env });
          ctx.run.log(`✓ 在 ${REPO} 创建 tag ref ${ctx.tag}`, "ok");
        }

        const notes = path.join(ctx.stageDir, "build/release-notes.md");
        if (!fs.existsSync(notes)) throw new Error(`缺 release notes：${notes}`);

        // 上传前逐类清点，缺任何一类都不要开始传——传一半的 release 比没传更糟。
        const required = [/-arm64\.dmg$/, /-arm64\.zip$/, /-x64\.dmg$/, /-x64\.zip$/, /^latest-mac\.yml$/];
        for (const re of required) {
          if (!fs.readdirSync(ctx.stageDir).some((f) => re.test(f))) throw new Error(`缺产物：${re}`);
        }

        const exists = await ctx.run.capture("gh", ["release", "view", ctx.tag, "--repo", REPO], { env });
        if (!exists.ok) {
          await ctx.run.exec("gh", ["release", "create", ctx.tag, "--repo", REPO, "--title", ctx.tag.replace(/^v/, ""), "--notes-file", notes], { env });
        }
        const assets = findFiles(ctx.stageDir, (f) => /\.(dmg|zip)(\.blockmap)?$/.test(f) || f === "latest-mac.yml");
        await ctx.run.exec("gh", ["release", "upload", ctx.tag, "--repo", REPO, "--clobber", ...assets], { env });
        ctx.run.log(`✓ 已发布 ${ctx.tag}(macOS arm64 + x64) → https://github.com/${REPO}/releases/tag/${ctx.tag}`, "ok");
      },
    },
  ];
}

export const RELEASE_REPO = REPO;
