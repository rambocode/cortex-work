// 发布控制台的 HTTP 服务：静态页 + REST + SSE 实时推流。
//
// 刻意零依赖(只用 node: 内置模块):这是条发版工具链,越少东西能坏越好——总不能因为装不上
// 某个 web 框架而发不了版。前端同理,原生 HTML/JS,没有构建步骤。

import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ReleaseRun, STATUS } from "./runner.mjs";
import { buildSteps, RELEASE_REPO } from "./steps.mjs";
import { runPreflight } from "./preflight.mjs";
import { fetchHistory, fetchInfo } from "./notary.mjs";
import { applyTag, collectReleaseInput, draftReleaseNotes, isValidVersion, nextPatchVersion } from "./tagger.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "../..");
const PORT = Number(process.env.RELEASE_UI_PORT || 5178);

/** 解析仓库根 .env（Apple 公证凭据等）。刻意不引 dotenv：格式简单，自己切一行足够。 */
function loadEnvFile() {
  const file = path.join(REPO_ROOT, ".env");
  const out = {};
  if (!fs.existsSync(file)) return out;
  for (const line of fs.readFileSync(file, "utf8").split("\n")) {
    const m = /^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*)\s*$/.exec(line);
    if (!m) continue;
    out[m[1]] = m[2].replace(/^["']|["']$/g, "");
  }
  return out;
}

const envFile = loadEnvFile();
const creds = {
  appleId: envFile.APPLE_ID || process.env.APPLE_ID || "",
  appPassword: envFile.APPLE_APP_SPECIFIC_PASSWORD || process.env.APPLE_APP_SPECIFIC_PASSWORD || "",
  teamId: envFile.APPLE_TEAM_ID || process.env.APPLE_TEAM_ID || "HQ537XMLJY",
  keychainProfile: envFile.APPLE_KEYCHAIN_PROFILE || process.env.APPLE_KEYCHAIN_PROFILE || "",
};
// 子进程环境：electron-builder 的公证步骤就是从这些环境变量里取凭据的。
const childEnv = { ...process.env, ...envFile, APPLE_TEAM_ID: creds.teamId };

function readDesktopVersion() {
  return JSON.parse(fs.readFileSync(path.join(REPO_ROOT, "apps/desktop/package.json"), "utf8")).version;
}

/** 由版本号派生出整条流水线的上下文。暂存目录按 tag 分开并落在仓库外的固定位置:
 *  必须跨进程重启存活,否则「续跑」就无从谈起（原脚本用 mktemp,进程一退产物就散了）。 */
function contextFor(version) {
  const tag = `v${version}`;
  return {
    version,
    tag,
    stageDir: path.join(REPO_ROOT, ".release-stage", tag),
    stateFile: path.join(REPO_ROOT, ".release-stage", `${tag}.state.json`),
  };
}

// 刻意不是 const:版本号会在控制台自己打 tag 后变,也可能被人手改 package.json。整条流水线的
// tag/暂存目录/状态文件都由它派生,一旦读死在启动那一刻,后续发布会用旧 tag 发新代码(实测事故)。
let ctx = contextFor(readDesktopVersion());

const stepDefs = buildSteps();
const run = new ReleaseRun({ repoRoot: REPO_ROOT, stateFile: ctx.stateFile });
run.init(stepDefs, ctx);
run.restore();

/**
 * 重读 package.json 版本，变了就把上下文与阶段状态整体切过去。返回是否发生了切换。
 * 发布流程运行中一律不切:跑到一半换 tag 会让状态机与已产出的暂存产物对不上。
 */
function syncVersion() {
  if (inflight) return false;
  let latest;
  try {
    latest = readDesktopVersion();
  } catch {
    return false; // package.json 正被编辑器写到一半之类，下次再说
  }
  if (latest === ctx.version) return false;
  const from = ctx.tag;
  ctx = contextFor(latest);
  run.stateFile = ctx.stateFile;
  run.init(stepDefs, ctx);
  run.restore();
  run.log(`版本已切换：${from} → ${ctx.tag}`, "stage");
  run.emitUpdate();
  return true;
}

// ── SSE 订阅者 ────────────────────────────────────────────────────────────────
const clients = new Set();
function broadcast(event, data) {
  const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const res of clients) res.write(payload);
}
run.on("log", (entry) => broadcast("log", entry));
run.on("update", (snap) => broadcast("state", snap));

// ── 流程编排 ──────────────────────────────────────────────────────────────────
let inflight = null;
// 打 tag 与发布流程互斥:两者都动 git 工作区与版本上下文,叠在一起跑必然互相踩。
let tagging = false;

/**
 * 从第一个未完成的阶段开始往下跑。
 * mode="resume" 跳过已完成阶段（默认，也是这个工具存在的意义）；mode="all" 全部重跑。
 */
async function startRelease({ mode = "resume", stopAfter = null } = {}) {
  if (inflight) throw new Error("已有发布流程在跑");
  run.aborted = false;
  run.startedAt = Date.now();
  run.finishedAt = null;
  if (mode === "all") {
    for (const s of run.steps) {
      s.status = STATUS.PENDING;
      s.startedAt = s.finishedAt = s.error = null;
    }
    run.persist();
  }
  run.emitUpdate();

  // 陷阱:不能在 async 函数体内部（finally 里）写 `inflight = null`——当所有阶段都已完成时,
  // 循环全走 continue、一个 await 都没有,整个函数体（含 finally）会**同步**执行完,
  // 之后外层的 `inflight = job` 赋值才发生,把 null 覆盖回一个已 resolve 的 promise,
  // 此后每次「开始发布」都误报「已有发布流程在跑」直到重启（v0.1.54 实测踩到）。
  // 因此清理挪到 .finally() 回调:它保证在微任务里异步执行,一定晚于下面的赋值。
  const job = (async () => {
    try {
      for (const def of stepDefs) {
        const st = run.step(def.id);
        if (st.status === STATUS.DONE) {
          run.log(`⏭ 跳过已完成阶段：${def.title}`, "skip");
          continue;
        }
        if (run.aborted) throw new Error("已被用户停止");
        run.markStep(def.id, STATUS.RUNNING);
        run.log(`▶ ${def.group} · ${def.title}`, "stage");
        try {
          await def.run({ run, repoRoot: REPO_ROOT, tag: ctx.tag, version: ctx.version, stageDir: ctx.stageDir, env: childEnv });
          run.markStep(def.id, STATUS.DONE);
        } catch (err) {
          run.markStep(def.id, STATUS.FAILED, String(err?.message ?? err));
          run.log(`✗ 阶段失败：${def.title} — ${err?.message ?? err}`, "error");
          throw err;
        }
        if (stopAfter && def.id === stopAfter) {
          run.log(`⏸ 已按要求在「${def.title}」后停止`, "stage");
          break;
        }
      }
      run.log("🎉 全部阶段完成", "ok");
    } finally {
      run.finishedAt = Date.now();
      run.emitUpdate();
    }
  })();

  inflight = job;
  // 失败已记录进状态与日志，这里吞掉避免 unhandled rejection；结束后清 inflight 放行下一轮。
  job.catch(() => {}).finally(() => {
    if (inflight === job) inflight = null;
  });
}

// ── HTTP ──────────────────────────────────────────────────────────────────────
function sendJson(res, code, body) {
  const buf = Buffer.from(JSON.stringify(body));
  res.writeHead(code, { "content-type": "application/json; charset=utf-8", "content-length": buf.length });
  res.end(buf);
}

function readBody(req) {
  return new Promise((resolve) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      try {
        resolve(raw ? JSON.parse(raw) : {});
      } catch {
        resolve({});
      }
    });
  });
}

const MIME = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8" };

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  const p = url.pathname;

  try {
    if (p === "/api/events") {
      syncVersion();
      res.writeHead(200, {
        "content-type": "text/event-stream",
        "cache-control": "no-cache",
        connection: "keep-alive",
      });
      clients.add(res);
      res.write(`event: state\ndata: ${JSON.stringify(run.snapshot())}\n\n`);
      // 补发日志尾巴，刷新页面不至于丢失上下文。
      for (const entry of run.logs.slice(-400)) res.write(`event: log\ndata: ${JSON.stringify(entry)}\n\n`);
      // 心跳:防止中间层把长连接当空闲砍掉（构建阶段可能十几分钟没有新日志）。
      const hb = setInterval(() => res.write(": ping\n\n"), 20_000);
      req.on("close", () => {
        clearInterval(hb);
        clients.delete(res);
      });
      return;
    }

    if (p === "/api/state") {
      syncVersion();
      return sendJson(res, 200, {
        version: ctx.version,
        tag: ctx.tag,
        nextVersion: nextPatchVersion(ctx.version),
        repo: RELEASE_REPO,
        stageDir: ctx.stageDir,
        run: run.snapshot(),
      });
    }

    if (p === "/api/preflight") {
      syncVersion();
      const result = await runPreflight({ repoRoot: REPO_ROOT, version: ctx.version, tag: ctx.tag, creds });
      return sendJson(res, 200, result);
    }

    if (p === "/api/notary") {
      const id = url.searchParams.get("id");
      if (id) return sendJson(res, 200, await fetchInfo(creds, id));
      return sendJson(res, 200, await fetchHistory(creds));
    }

    if (p === "/api/start" && req.method === "POST") {
      const body = await readBody(req);
      if (inflight) return sendJson(res, 409, { error: "已有发布流程在跑" });
      if (tagging) return sendJson(res, 409, { error: "正在打 tag，稍后再开始发布" });
      // 必须先同步版本再跑前置检查:否则会拿旧 tag 校验、又用旧 tag 发新代码。
      syncVersion();
      const pre = await runPreflight({ repoRoot: REPO_ROOT, version: ctx.version, tag: ctx.tag, creds });
      if (!pre.canRelease && !body.force) {
        return sendJson(res, 412, { error: "前置检查未通过", checks: pre.checks });
      }
      await startRelease({ mode: body.mode === "all" ? "all" : "resume", stopAfter: body.stopAfter ?? null });
      return sendJson(res, 200, { ok: true });
    }

    if (p === "/api/stop" && req.method === "POST") {
      const killed = run.stop();
      run.log(killed ? "⏹ 已请求停止当前阶段" : "⏹ 当前没有运行中的子进程", "warn");
      return sendJson(res, 200, { ok: true, killed });
    }

    if (p === "/api/reset" && req.method === "POST") {
      if (inflight) return sendJson(res, 409, { error: "流程运行中，先停止再重置" });
      for (const s of run.steps) {
        s.status = STATUS.PENDING;
        s.startedAt = s.finishedAt = s.error = null;
      }
      run.logs = [];
      run.persist();
      run.emitUpdate();
      return sendJson(res, 200, { ok: true });
    }

    // ── 打 tag（两步：先出草稿供人审阅编辑，再落盘 commit+tag）────────────────────
    // 刻意不进 run.steps 状态机:阶段列表代表「一次发布的产物流水线」,把打 tag 混进去会污染
    // .release-stage/<tag>.state.json 的续跑进度（打完 tag 版本就变了，旧进度本该作废）。
    // 只借 run.log 把过程打进同一条实时日志，用户仍能在日志面板看到全过程。
    if (p === "/api/tag/draft" && req.method === "POST") {
      const body = await readBody(req);
      if (inflight || tagging) return sendJson(res, 409, { error: "发布流程或打 tag 正在进行中" });
      syncVersion();
      const version = body.version || nextPatchVersion(ctx.version);
      if (!isValidVersion(version)) return sendJson(res, 400, { error: `版本号格式不对：${version}` });
      tagging = true;
      try {
        const input = await collectReleaseInput({ repoRoot: REPO_ROOT, run });
        const notes = await draftReleaseNotes({ repoRoot: REPO_ROOT, run, input, version, env: childEnv });
        return sendJson(res, 200, { version, prevTag: input.prevTag, commitCount: input.commitCount, notes });
      } catch (err) {
        run.log(`✗ 生成发布说明失败：${err?.message ?? err}`, "error");
        return sendJson(res, 500, { error: String(err?.message ?? err) });
      } finally {
        tagging = false;
      }
    }

    if (p === "/api/tag/apply" && req.method === "POST") {
      const body = await readBody(req);
      if (inflight || tagging) return sendJson(res, 409, { error: "发布流程或打 tag 正在进行中" });
      tagging = true;
      try {
        run.log(`▶ 写入 CHANGELOG 并打 tag v${body.version}${body.push ? "（含推送）" : ""}`, "stage");
        const result = await applyTag({
          repoRoot: REPO_ROOT,
          run,
          version: body.version,
          notes: body.notes,
          push: Boolean(body.push),
          env: childEnv,
        });
        return sendJson(res, 200, { ok: true, ...result });
      } catch (err) {
        run.log(`✗ 打 tag 失败：${err?.message ?? err}`, "error");
        return sendJson(res, 500, { error: String(err?.message ?? err) });
      } finally {
        tagging = false;
        // 版本已变:切换上下文让 chip、暂存目录、前置检查全部跟上（失败路径下是无操作）。
        syncVersion();
      }
    }

    // 浏览器会自动请求 favicon，没有就是一条刺眼的 404——直接回 204 收敛掉。
    if (p === "/favicon.ico") {
      res.writeHead(204).end();
      return;
    }

    // 静态资源
    const file = p === "/" ? "index.html" : p.replace(/^\//, "");
    const abs = path.join(__dirname, "public", file);
    if (abs.startsWith(path.join(__dirname, "public")) && fs.existsSync(abs) && fs.statSync(abs).isFile()) {
      const body = fs.readFileSync(abs);
      res.writeHead(200, { "content-type": MIME[path.extname(abs)] ?? "application/octet-stream" });
      return res.end(body);
    }
    res.writeHead(404).end("not found");
  } catch (err) {
    sendJson(res, 500, { error: String(err?.message ?? err) });
  }
});

server.listen(PORT, () => {
  console.log(`\n  Cortex 发布控制台  →  http://localhost:${PORT}`);
  console.log(`  版本 ${ctx.version} · tag ${ctx.tag} · 目标仓库 ${RELEASE_REPO}\n`);
});
