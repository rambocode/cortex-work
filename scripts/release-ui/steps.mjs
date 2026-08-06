// macOS 双架构发布流程的阶段定义。逐条对应 scripts/local-release-mac.sh，语义必须保持一致。
//
// 【顺序为什么不能动】两个架构仍串行:阶段编排与断点续跑状态机按串行设计(原先
// 「resources/pi/ 单一共享目录」的理由已随 pi gateway 化删除而消失,是否可并行需单独评估)。
// 只能「建 arm64 → 打包 → 把产物拷走 → 建 x64 → 打包」。x64 的 prepackage 一旦跑起来,
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

// 上传通道:默认 gh(官方客户端,--clobber 幂等)。
// `RELEASE_UPLOAD_VIA=curl` 切到 curl 兜底——它能限速,代理链路不稳、大文件反复被重置时才需要。
// v0.1.49 那次连续中断是本机代理的问题,不是 gh 的问题,所以默认保持 gh。
const VIA_CURL = process.env.RELEASE_UPLOAD_VIA === "curl";

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
// 公证上传是瞬态故障高发点:产物 zip 有数百 MB,经 notarytool 分片上传到 Apple 的 S3,
// 链路一抖就是 abortedUpload / "Connection reset by peer"——v0.1.49 连续三轮栽在同一处。
// electron-builder 自身不重试,失败即整个 build 退出。
const TRANSIENT_NOTARY_PATTERNS = [
  /abortedUpload/i,
  /Failed to notarize/i,
  /Connection reset by peer/i,
  /NWError error 54/i,
  /The network connection was lost/i,
];

/** 从最近日志里判断这次失败是不是「公证上传被中断」这类值得重试的瞬态故障。 */
function looksTransient(run) {
  const tail = run.logs.slice(-80).map((l) => l.text).join("\n");
  return TRANSIENT_NOTARY_PATTERNS.some((re) => re.test(tail));
}

export function buildSteps() {
  const pnpmDesktop = (script, extraEnv = {}) => async (ctx) => {
    await ctx.run.exec("pnpm", ["--filter", "@cortex-work/desktop", "run", script], {
      env: { ...ctx.env, ...extraEnv },
    });
  };

  /**
   * 打包+公证专用:失败后若判定为瞬态网络故障就自动重试。
   * 只对「看起来是公证/网络」的失败重试——签名证书错误、编译失败这类确定性问题重试多少次都一样,
   * 白烧十几分钟还会把真正的错误埋进一堆重复日志里。
   */
  const buildWithRetry = (script) => async (ctx) => {
    const MAX_ATTEMPTS = 3;
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      try {
        await ctx.run.exec("pnpm", ["--filter", "@cortex-work/desktop", "run", script], {
          env: { ...ctx.env, CSC_NAME },
        });
        return;
      } catch (err) {
        if (ctx.run.aborted) throw err;
        if (attempt >= MAX_ATTEMPTS || !looksTransient(ctx.run)) throw err;
        ctx.run.log(
          `⟳ 第 ${attempt} 次公证上传中断（瞬态网络故障），30 秒后重试（最多 ${MAX_ATTEMPTS} 次）`,
          "warn",
        );
        await new Promise((r) => setTimeout(r, 30_000));
      }
    }
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
      run: buildWithRetry("build:mac-arm64"),
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
      run: buildWithRetry("build:mac-x64"),
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

        // 逐个上传而不是一次传完:单个 dmg/zip 有 200MB,一次性传 9 个时任何一个连接被重置都会让
        // 整批重来(v0.1.49 实测踩到)。
        const assets = findFiles(ctx.stageDir, (f) => /\.(dmg|zip)(\.blockmap)?$/.test(f) || f === "latest-mac.yml");
        // latest-mac.yml 放最后传:更新清单一旦就位,客户端就认为该版本可用。必须保证它出现时
        // 所有安装包都已传完,否则抢先更新的用户会撞上 404。
        assets.sort((a, b) => Number(a.endsWith("latest-mac.yml")) - Number(b.endsWith("latest-mac.yml")));

        const relId = (await ctx.run.capture("gh", ["api", `repos/${REPO}/releases/tags/${ctx.tag}`, "--jq", ".id"], { env })).stdout;
        if (!relId) throw new Error("取不到 release id");

        for (const [i, asset] of assets.entries()) {
          const name = path.basename(asset);
          const sizeMB = Math.round(fs.statSync(asset).size / 1048576);
          const label = `[${i + 1}/${assets.length}] ${name}（${sizeMB}MB）`;

          // 已经传完的直接跳过——续跑时不必重传几百 MB。
          //
          // 【必须校验 state】上传中断会在 release 上留下 state="starter" 的残骸,它带着完整的 name 和
          // size(GitHub 建记录时就按 Content-Length 预写了 size),只比对 name+size 会把「传失败的空壳」
          // 认成「已传好」,于是静默跳过 → 发布"成功"但用户下载 404。v0.1.49 实测踩到,只有
          // state=="uploaded" 才算数。
          const existing = await ctx.run.capture("gh", ["api", `repos/${REPO}/releases/${relId}/assets`, "--jq", `.[] | select(.name=="${name}") | "\\(.size) \\(.state)"`], { env });
          const [assetSize, assetState] = existing.stdout.split(/\s+/);
          if (assetState === "uploaded" && Number(assetSize) === fs.statSync(asset).size) {
            ctx.run.log(`⏭ ${label} 已完整存在，跳过`, "skip");
            continue;
          }

          const MAX = 8;
          for (let attempt = 1; ; attempt++) {
            let r;
            if (VIA_CURL) {
              // 兜底通道:仅在 RELEASE_UPLOAD_VIA=curl 时启用。gh 不支持限速,而代理链路不稳时
              // 大文件全速跑更容易被重置,降速反而传得完——这是 v0.1.49 期间试出来的经验解。
              // GitHub 不允许同名资产共存,curl 直传前必须先删掉旧的(gh 的 --clobber 自带这步)。
              const cur = await ctx.run.capture("gh", ["api", `repos/${REPO}/releases/${relId}/assets`, "--jq", `.[] | select(.name=="${name}") | .id`], { env });
              if (cur.stdout) {
                await ctx.run.capture("gh", ["api", "--method", "DELETE", `repos/${REPO}/releases/assets/${cur.stdout}`], { env });
              }
              const rate = attempt >= 2 ? ["--limit-rate", attempt >= 4 ? "2m" : "5m"] : [];
              r = await ctx.run.capture("curl", [
                "-sS", "-X", "POST",
                "-H", `Authorization: token ${env.GH_TOKEN}`,
                "-H", "Content-Type: application/octet-stream",
                "--data-binary", `@${asset}`,
                "--max-time", "3600",
                ...rate,
                "-w", "%{http_code}",
                `https://uploads.github.com/repos/${REPO}/releases/${relId}/assets?name=${encodeURIComponent(name)}`,
              ], { env });
              r.uploaded = r.ok && /(^|\D)201$/.test(r.stdout.trim());
            } else {
              // 默认走 gh:--clobber 覆盖同名资产,天然幂等,重试安全。
              r = await ctx.run.capture("gh", ["release", "upload", ctx.tag, "--repo", REPO, "--clobber", asset], { env });
              r.uploaded = r.ok;
            }

            if (r.uploaded) {
              // 命令成功只代表请求被接受,还要回查一次 state:确认 GitHub 侧真的落成 uploaded 而非
              // starter(中断残骸)。这道校验与用哪个上传通道无关,两条路径都要过。
              const chk = await ctx.run.capture("gh", ["api", `repos/${REPO}/releases/${relId}/assets`, "--jq", `.[] | select(.name=="${name}") | .state`], { env });
              if (chk.stdout === "uploaded") {
                ctx.run.log(`✓ ${label}${attempt > 1 ? `（第 ${attempt} 次成功）` : ""}`, "ok");
                break;
              }
              ctx.run.log(`⚠ ${label} 上传命令成功但服务端状态为 ${chk.stdout || "未知"}，按失败处理`, "warn");
            }
            if (attempt >= MAX) {
              throw new Error(`上传 ${name} 失败（已重试 ${MAX} 次）：${(r.stderr || r.stdout).slice(0, 200)}`);
            }
            ctx.run.log(`⟳ ${label} 上传中断，15 秒后重试（第 ${attempt}/${MAX} 次${attempt >= 2 ? "，已降速" : ""}）`, "warn");
            await new Promise((res) => setTimeout(res, 15_000));
          }
        }
        // 【最终护栏】逐个比对 release 上的资产:名字齐、大小对、state 全是 uploaded,才算真的发布完成。
        // 没有这道校验,「某个包其实没传上去」会一路静默到用户更新时才暴露成 404。
        const remote = await ctx.run.capture("gh", ["api", `repos/${REPO}/releases/${relId}/assets`, "--jq", `.[] | "\\(.name)\\t\\(.size)\\t\\(.state)"`], { env });
        const remoteMap = new Map(remote.stdout.split("\n").filter(Boolean).map((l) => {
          const [n, sz, st] = l.split("\t");
          return [n, { size: Number(sz), state: st }];
        }));
        const missing = [];
        for (const asset of assets) {
          const name = path.basename(asset);
          const got = remoteMap.get(name);
          const want = fs.statSync(asset).size;
          if (!got) missing.push(`${name}（未上传）`);
          else if (got.state !== "uploaded") missing.push(`${name}（state=${got.state}）`);
          else if (got.size !== want) missing.push(`${name}（大小 ${got.size} ≠ 本地 ${want}）`);
        }
        if (missing.length) throw new Error(`发布校验失败，以下资产不完整：${missing.join("、")}`);

        ctx.run.log(`✓ 全部 ${assets.length} 个资产校验通过（名称/大小/state 均一致）`, "ok");
        ctx.run.log(`✓ 已发布 ${ctx.tag}(macOS arm64 + x64) → https://github.com/${REPO}/releases/tag/${ctx.tag}`, "ok");
      },
    },
  ];
}

export const RELEASE_REPO = REPO;
