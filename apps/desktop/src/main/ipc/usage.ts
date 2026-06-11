// Agent 用量统计（移植自 fanbox server.js）。不依赖 CLI 在跑,直接读本机会话日志:
//   Claude Code: ~/.claude/projects/**/*.jsonl 的 assistant usage → 增量解析,按 近5h/今日/本周 分桶
//   Claude 官方限额: Keychain/credentials 取 OAuth token → curl api.anthropic.com/api/oauth/usage
//     （必须系统 curl:该接口按 TLS 指纹拦,Node https 会 403;这是唯一出网请求）
//   Codex: ~/.codex/sessions/**/rollout-*.jsonl 尾部最后一条带 rate_limits 的 token_count（官方配额快照）

import { ipcMain } from "electron";
import { promises as fsp } from "fs";
import { homedir } from "os";
import { join } from "path";
import { execFile } from "child_process";

const HOME = homedir();
const CLAUDE_PROJ = join(HOME, ".claude", "projects");
const CODEX_SESS = join(HOME, ".codex", "sessions");

interface UsageEvent {
  t: number;
  in: number;
  out: number;
  cc: number;
  cr: number;
}

interface FileCache {
  offset: number;
  lastMsgId: string;
  events: UsageEvent[];
}

const claudeFileCache = new Map<string, FileCache>();
let resultCache: { at: number; data: unknown } = { at: 0, data: null };

async function parseClaudeFile(file: string, stat: { size: number; mtimeMs: number }): Promise<UsageEvent[]> {
  let c = claudeFileCache.get(file);
  if (!c) {
    c = { offset: 0, lastMsgId: "", events: [] };
    claudeFileCache.set(file, c);
  }
  if (stat.size < c.offset) {
    c.offset = 0;
    c.lastMsgId = "";
    c.events = [];
  }
  if (stat.size === c.offset) return c.events;
  const fh = await fsp.open(file, "r");
  let chunk: string;
  try {
    const len = stat.size - c.offset;
    const buf = Buffer.alloc(len);
    await fh.read(buf, 0, len, c.offset);
    chunk = buf.toString("utf8");
  } finally {
    await fh.close();
  }
  // 末尾可能是写一半的行,offset 只推进到最后一个完整换行
  const lastNL = chunk.lastIndexOf("\n");
  if (lastNL === -1) return c.events;
  c.offset += Buffer.byteLength(chunk.slice(0, lastNL + 1), "utf8");
  for (const line of chunk.slice(0, lastNL).split("\n")) {
    if (!line.includes('"usage"') || !line.includes('"assistant"')) continue;
    let d: Record<string, unknown>;
    try {
      d = JSON.parse(line);
    } catch {
      continue;
    }
    const m = d?.message as Record<string, unknown> | undefined;
    const u = m?.usage as Record<string, number> | undefined;
    if (!u || d.type !== "assistant") continue;
    if (m!.model === "<synthetic>") continue;
    // 同一条消息分多行落盘,usage 重复:只记第一次
    if (m!.id && m!.id === c.lastMsgId) continue;
    if (m!.id) c.lastMsgId = m!.id as string;
    const t = Date.parse((d.timestamp as string) || "") || stat.mtimeMs;
    c.events.push({
      t,
      in: u.input_tokens || 0,
      out: u.output_tokens || 0,
      cc: u.cache_creation_input_tokens || 0,
      cr: u.cache_read_input_tokens || 0,
    });
  }
  return c.events;
}

function mkBucket() {
  return { total: 0, input: 0, output: 0, cacheRead: 0, cacheCreate: 0, msgs: 0 };
}

async function claudeTokenBuckets() {
  const cutoff = Date.now() - 8 * 86400000;
  const files: { fp: string; st: { size: number; mtimeMs: number } }[] = [];
  let dirs: string[];
  try {
    dirs = await fsp.readdir(CLAUDE_PROJ);
  } catch {
    return null; // 没装/没用过 Claude Code
  }
  await Promise.all(
    dirs.map(async (d) => {
      let names: string[];
      try {
        names = await fsp.readdir(join(CLAUDE_PROJ, d));
      } catch {
        return;
      }
      await Promise.all(
        names
          .filter((n) => n.endsWith(".jsonl"))
          .map(async (n) => {
            const fp = join(CLAUDE_PROJ, d, n);
            try {
              const st = await fsp.stat(fp);
              if (st.mtimeMs >= cutoff) files.push({ fp, st });
            } catch {
              /* skip */
            }
          }),
      );
    }),
  );
  const live = new Set(files.map((f) => f.fp));
  for (const k of claudeFileCache.keys()) if (!live.has(k)) claudeFileCache.delete(k);

  const all: UsageEvent[] = [];
  for (const { fp, st } of files) {
    try {
      all.push(...(await parseClaudeFile(fp, st)));
    } catch {
      /* 单文件坏不挡整体 */
    }
  }
  const now = Date.now();
  const dayStart = new Date();
  dayStart.setHours(0, 0, 0, 0);
  const last5h = mkBucket(),
    today = mkBucket(),
    week = mkBucket();
  const buckets: [ReturnType<typeof mkBucket>, number][] = [
    [last5h, now - 5 * 3600000],
    [today, dayStart.getTime()],
    [week, now - 7 * 86400000],
  ];
  for (const e of all) {
    const tot = e.in + e.out + e.cc + e.cr;
    for (const [b, from] of buckets) {
      if (e.t >= from) {
        b.total += tot;
        b.input += e.in;
        b.output += e.out;
        b.cacheRead += e.cr;
        b.cacheCreate += e.cc;
        b.msgs++;
      }
    }
  }
  return { last5h, today, week };
}

// Codex: 最近会话文件尾部抓最后一条 rate_limits 快照
async function codexUsage() {
  const files: { fp: string; mtimeMs: number; size: number }[] = [];
  const walk = async (dir: string, depth: number) => {
    let names;
    try {
      names = await fsp.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const n of names) {
      const fp = join(dir, n.name);
      if (n.isDirectory() && depth < 3) await walk(fp, depth + 1);
      else if (n.isFile() && n.name.endsWith(".jsonl")) {
        try {
          const st = await fsp.stat(fp);
          files.push({ fp, mtimeMs: st.mtimeMs, size: st.size });
        } catch {
          /* skip */
        }
      }
    }
  };
  await walk(CODEX_SESS, 0);
  if (!files.length) return null;
  files.sort((a, b) => b.mtimeMs - a.mtimeMs);
  for (const f of files.slice(0, 10)) {
    try {
      const fh = await fsp.open(f.fp, "r");
      let txt: string;
      try {
        const len = Math.min(f.size, 262144);
        const buf = Buffer.alloc(len);
        await fh.read(buf, 0, len, f.size - len);
        txt = buf.toString("utf8");
      } finally {
        await fh.close();
      }
      for (const line of txt.split("\n").reverse()) {
        if (!line.includes('"rate_limits"')) continue;
        let d: Record<string, unknown>;
        try {
          d = JSON.parse(line);
        } catch {
          continue;
        }
        const pl = d?.payload as Record<string, unknown> | undefined;
        const rl = pl?.rate_limits as Record<string, unknown> | undefined;
        if (!rl || (!rl.primary && !rl.secondary)) continue;
        const capturedAt = Date.parse((d.timestamp as string) || "") || f.mtimeMs;
        // 快照是「当时」的数:窗口在快照后已重置则百分比失真 → 归零标 stale
        const win = (w: Record<string, unknown> | undefined) => {
          if (!w) return null;
          let resetsAt = (w.resets_at as number | string) || 0;
          if (typeof resetsAt === "string") resetsAt = Math.floor(Date.parse(resetsAt) / 1000) || 0;
          let end = (resetsAt as number) * 1000;
          if (!end && w.resets_in_seconds != null) end = capturedAt + (w.resets_in_seconds as number) * 1000;
          if (!end && w.window_minutes) end = capturedAt + (w.window_minutes as number) * 60000;
          const stale = !!end && end < Date.now();
          return {
            usedPercent: stale ? 0 : (w.used_percent as number) || 0,
            windowMinutes: w.window_minutes as number | undefined,
            resetsAt: stale ? 0 : (resetsAt as number),
            stale,
          };
        };
        return {
          planType: (rl.plan_type as string) || "",
          capturedAt,
          primary: win(rl.primary as Record<string, unknown>),
          secondary: win(rl.secondary as Record<string, unknown>),
        };
      }
    } catch {
      /* 下一个文件 */
    }
  }
  return null;
}

// Claude Code OAuth token: macOS Keychain 优先,回退 ~/.claude/.credentials.json
async function claudeOAuthToken(): Promise<string | null> {
  const pick = (raw: string): string | null => {
    const o = JSON.parse(raw).claudeAiOauth;
    return o?.accessToken && (!o.expiresAt || o.expiresAt > Date.now()) ? o.accessToken : null;
  };
  if (process.platform === "darwin") {
    try {
      const out = await new Promise<string>((resolve, reject) => {
        execFile(
          "security",
          ["find-generic-password", "-s", "Claude Code-credentials", "-w"],
          { timeout: 3000 },
          (err, stdout) => (err ? reject(err) : resolve(stdout)),
        );
      });
      const t = pick(out);
      if (t) return t;
    } catch {
      /* 落到凭证文件 */
    }
  }
  try {
    return pick(await fsp.readFile(join(HOME, ".claude", ".credentials.json"), "utf8"));
  } catch {
    return null;
  }
}

// GUI 启动缺代理环境变量时读 macOS 系统代理兜底（Clash 等会写进去）
async function curlSysProxyLine(): Promise<string> {
  const proxyKeys = ["https_proxy", "HTTPS_PROXY", "http_proxy", "HTTP_PROXY", "all_proxy", "ALL_PROXY"];
  if (proxyKeys.some((k) => process.env[k])) return "";
  if (process.platform !== "darwin") return "";
  try {
    const out = await new Promise<string>((resolve, reject) => {
      execFile("scutil", ["--proxy"], { timeout: 3000 }, (err, stdout) => (err ? reject(err) : resolve(stdout)));
    });
    const grab = (k: string) => (out.match(new RegExp(`\\b${k} : (\\S+)`)) || [])[1];
    if (grab("HTTPSEnable") === "1") return `proxy = "http://${grab("HTTPSProxy")}:${grab("HTTPSPort")}"\n`;
    if (grab("HTTPEnable") === "1") return `proxy = "http://${grab("HTTPProxy")}:${grab("HTTPPort")}"\n`;
    if (grab("SOCKSEnable") === "1") return `proxy = "socks5h://${grab("SOCKSProxy")}:${grab("SOCKSPort")}"\n`;
  } catch {
    /* 直连 */
  }
  return "";
}

async function claudeOfficialLimits() {
  const token = await claudeOAuthToken();
  if (!token) return null;
  // 系统 curl 而非 Node https:接口按 TLS 指纹拦,Node 直连 403;token 走 stdin 不进进程列表
  const proxyLine = await curlSysProxyLine();
  const body = await new Promise<string>((resolve, reject) => {
    const cp = execFile(
      "curl",
      ["-sS", "--max-time", "8", "-K", "-", "https://api.anthropic.com/api/oauth/usage"],
      { timeout: 10000 },
      (err, stdout) => (err ? reject(err) : resolve(stdout)),
    );
    cp.stdin!.end(`${proxyLine}header = "Authorization: Bearer ${token}"\nheader = "anthropic-beta: oauth-2025-04-20"\n`);
  });
  const d = JSON.parse(body);
  const win = (w: { utilization?: number; resets_at?: string } | undefined) =>
    w && w.utilization != null
      ? { usedPercent: w.utilization, resetsAt: w.resets_at ? Math.floor(Date.parse(w.resets_at) / 1000) : 0 }
      : null;
  const fiveHour = win(d.five_hour),
    sevenDay = win(d.seven_day);
  return fiveHour || sevenDay ? { fiveHour, sevenDay } : null;
}

export function registerUsageHandlers(): void {
  ipcMain.handle("usage:agent", async () => {
    if (resultCache.data && Date.now() - resultCache.at < 30_000) return resultCache.data;
    const [buckets, codex, official] = await Promise.all([
      claudeTokenBuckets().catch(() => null),
      codexUsage().catch(() => null),
      claudeOfficialLimits().catch(() => null),
    ]);
    const data = {
      at: Date.now(),
      claude: buckets ? { ...buckets, official } : official ? { last5h: mkBucket(), today: mkBucket(), week: mkBucket(), official } : null,
      codex,
    };
    resultCache = { at: Date.now(), data };
    return data;
  });
}
