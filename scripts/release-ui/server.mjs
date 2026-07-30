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

const version = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, "apps/desktop/package.json"), "utf8")).version;
const tag = `v${version}`;
// 暂存目录按 tag 分开并落在仓库外的固定位置:必须跨进程重启存活,否则「续跑」就无从谈起
// （原脚本用 mktemp,进程一退产物就散了）。
const stageDir = path.join(REPO_ROOT, ".release-stage", tag);
const stateFile = path.join(REPO_ROOT, ".release-stage", `${tag}.state.json`);

const stepDefs = buildSteps();
const run = new ReleaseRun({ repoRoot: REPO_ROOT, stateFile });
run.init(stepDefs, { tag, version, stageDir });
run.restore();

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

  inflight = (async () => {
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
          await def.run({ run, repoRoot: REPO_ROOT, tag, version, stageDir, env: childEnv });
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
      inflight = null;
      run.emitUpdate();
    }
  })();

  inflight.catch(() => {}); // 失败已记录进状态与日志，这里吞掉避免 unhandled rejection
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
      return sendJson(res, 200, { version, tag, repo: RELEASE_REPO, stageDir, run: run.snapshot() });
    }

    if (p === "/api/preflight") {
      const result = await runPreflight({ repoRoot: REPO_ROOT, version, tag, creds });
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
      const pre = await runPreflight({ repoRoot: REPO_ROOT, version, tag, creds });
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
  console.log(`  版本 ${version} · tag ${tag} · 目标仓库 ${RELEASE_REPO}\n`);
});
