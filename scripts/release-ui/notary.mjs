// Apple 公证队列查询。发布控制台里唯一「不属于本机流程」的信息源。
//
// 为什么单独做一块面板:公证是整条发布链上唯一不受本机控制的一环。electron-builder 调 notarytool
// 时只在最后吐一句 "Failed to notarize"（v0.1.49 那次连错误正文都是空的），从终端上完全看不出
// 到底是「产物有问题被拒」还是「Apple 在排队」——这两种情况的处置天差地别:前者要改代码,
// 后者只需要等。把 submission 列表和各自的状态/已等时长直接摆在界面上,这个判断就是一眼的事。

import { spawn } from "node:child_process";

/** 组装 notarytool 的鉴权参数：优先钥匙串 profile，其次 Apple ID + 专用密码。 */
function authArgs(creds) {
  if (creds.keychainProfile) return ["--keychain-profile", creds.keychainProfile];
  return [
    "--apple-id",
    creds.appleId,
    "--password",
    creds.appPassword,
    "--team-id",
    creds.teamId || "HQ537XMLJY",
  ];
}

export function hasNotaryCreds(creds) {
  return Boolean(creds?.keychainProfile || (creds?.appleId && creds?.appPassword));
}

function run(args, timeoutMs = 60_000) {
  return new Promise((resolve) => {
    const child = spawn("xcrun", args, { stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    let err = "";
    const timer = setTimeout(() => child.kill("SIGKILL"), timeoutMs);
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (err += d));
    child.on("error", () => {
      clearTimeout(timer);
      resolve({ ok: false, stdout: "", stderr: "xcrun 不可用" });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ ok: code === 0, stdout: out, stderr: err.trim() });
    });
  });
}

/**
 * 解析 `notarytool history` 的缩进文本输出。
 * 刻意不加 --output-format json:该子命令在部分 Xcode 版本上对 json 的字段命名不一致,
 * 而这段缩进格式多年未变,按 `key: value` 逐行切反而稳。以 createdDate 作为一条记录的起点。
 */
function parseHistory(text) {
  const items = [];
  let cur = null;
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    const m = /^([a-zA-Z]+):\s*(.*)$/.exec(line);
    if (!m) continue;
    const [, key, value] = m;
    if (key === "createdDate") {
      if (cur) items.push(cur);
      cur = { createdDate: value };
    } else if (cur && ["id", "name", "status"].includes(key)) {
      cur[key] = value;
    }
  }
  if (cur) items.push(cur);
  return items;
}

/** 取最近若干条公证提交。返回 { ok, items, error }。 */
export async function fetchHistory(creds, limit = 8) {
  if (!hasNotaryCreds(creds)) {
    return { ok: false, items: [], error: "未配置 Apple 公证凭据（.env 里的 APPLE_ID / APPLE_APP_SPECIFIC_PASSWORD）" };
  }
  const res = await run(["notarytool", "history", ...authArgs(creds)]);
  if (!res.ok) return { ok: false, items: [], error: res.stderr || "notarytool history 调用失败" };
  const items = parseHistory(res.stdout).slice(0, limit).map((it) => {
    const created = Date.parse(it.createdDate);
    return {
      id: it.id,
      name: it.name,
      status: it.status,
      createdDate: it.createdDate,
      // 已等时长:In Progress 条目的这个数字就是判断「Apple 是不是又堵了」的核心依据。
      waitedMs: Number.isFinite(created) ? Date.now() - created : null,
    };
  });
  return { ok: true, items, error: null };
}

/** 查单条提交的详情（含被拒时的 statusSummary）。 */
export async function fetchInfo(creds, submissionId) {
  if (!hasNotaryCreds(creds)) return { ok: false, error: "未配置 Apple 公证凭据" };
  const res = await run(["notarytool", "info", submissionId, ...authArgs(creds)]);
  if (!res.ok) return { ok: false, error: res.stderr || "notarytool info 调用失败" };
  const info = {};
  for (const raw of res.stdout.split("\n")) {
    const m = /^\s*([a-zA-Z]+):\s*(.*)$/.exec(raw);
    if (m) info[m[1]] = m[2].trim();
  }
  return { ok: true, info };
}
