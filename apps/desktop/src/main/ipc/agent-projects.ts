// 扫描本机 agent CLI 会话日志,聚合「系统上所有 agent 项目」（参考 fanbox）。
// Claude Code: ~/.claude/projects/<munged>/*.jsonl —— 目录名不可逆,取目录内最新
// jsonl 的 mtime 作活跃时间,读文件头反解 "cwd" 还原真实路径;
// Codex: ~/.codex/sessions/**/rollout-*.jsonl（递归 ≤3 层）同理。
// 未装某家 CLI / 单文件解析失败均静默跳过;结果 60s 缓存。

import { ipcMain } from "electron";
import { promises as fsp } from "fs";
import { homedir } from "os";
import { basename, join } from "path";
import { extractCwd } from "./agent-projects-parse";
import type { AgentKind, AgentProjectInfo } from "./types";
import { mapLimit } from "./scan-limit";

const HOME = homedir();
const CLAUDE_PROJ = join(HOME, ".claude", "projects");
const CODEX_SESS = join(HOME, ".codex", "sessions");
const CUTOFF_MS = 30 * 86400_000; // 只看近 30 天的会话
const CODEX_MAX_FILES = 40; // 只解析最新 N 个 rollout,控制 IO
const CODEX_MAX_DISCOVERED = 1200; // 发现阶段硬上限,避免历史会话极多时压垮主进程
const CLAUDE_MAX_PROJECT_DIRS = 500;
const CLAUDE_MAX_FILES_PER_DIR = 300;
const FS_SCAN_CONCURRENCY = 8;
const MAX_PROJECTS = 50;
const CACHE_TTL = 60_000;

async function readCwdFromHead(file: string, bytes: number): Promise<string | null> {
  const fh = await fsp.open(file, "r");
  try {
    const buf = Buffer.alloc(bytes);
    const { bytesRead } = await fh.read(buf, 0, bytes, 0);
    return extractCwd(buf.toString("utf8", 0, bytesRead));
  } finally {
    await fh.close();
  }
}

let cache: { at: number; data: AgentProjectInfo[] | null } = { at: 0, data: null };

async function scanAgentProjects(): Promise<AgentProjectInfo[]> {
  if (cache.data && Date.now() - cache.at < CACHE_TTL) return cache.data;
  const cutoff = Date.now() - CUTOFF_MS;
  const map = new Map<string, { lastActive: number; agents: Set<AgentKind> }>();
  const add = (cwd: string | null, mtime: number, agent: AgentKind): void => {
    if (!cwd || cwd === HOME) return; // 家目录裸跑的会话不算项目
    const cur = map.get(cwd) ?? { lastActive: 0, agents: new Set<AgentKind>() };
    cur.lastActive = Math.max(cur.lastActive, mtime);
    cur.agents.add(agent);
    map.set(cwd, cur);
  };

  // Claude Code：每个项目目录只 stat 出最新 jsonl,读它一个的头（64KB）。
  try {
    const dirs = (await fsp.readdir(CLAUDE_PROJ)).slice(0, CLAUDE_MAX_PROJECT_DIRS);
    await mapLimit(
      dirs,
      FS_SCAN_CONCURRENCY,
      async (dir) => {
        try {
          const dirPath = join(CLAUDE_PROJ, dir);
          const files = (await fsp.readdir(dirPath)).filter((f) => f.endsWith(".jsonl")).slice(0, CLAUDE_MAX_FILES_PER_DIR);
          let newest: { file: string; mtime: number } | null = null;
          for (const f of files) {
            const st = await fsp.stat(join(dirPath, f));
            if (!newest || st.mtimeMs > newest.mtime) newest = { file: join(dirPath, f), mtime: st.mtimeMs };
          }
          if (!newest || newest.mtime < cutoff) return;
          add(await readCwdFromHead(newest.file, 65536), newest.mtime, "claude");
        } catch {
          // 单项目目录损坏/不可读,跳过
        }
      },
    );
  } catch {
    // 未装 Claude Code
  }

  // Codex：递归收集近 30 天 rollout,按 mtime 只解析最新 N 个（头 16KB）。
  try {
    const rollouts: { file: string; mtime: number }[] = [];
    const walk = async (dir: string, depth: number): Promise<void> => {
      if (depth > 3) return;
      let entries;
      try {
        entries = await fsp.readdir(dir, { withFileTypes: true });
      } catch {
        return; // 子目录不可读:跳过该子树,而非让异常冒泡中断整轮 Codex 扫描
      }
      for (const ent of entries) {
        if (rollouts.length >= CODEX_MAX_DISCOVERED) break;
        const p = join(dir, ent.name);
        try {
          if (ent.isDirectory()) {
            await walk(p, depth + 1);
          } else if (ent.name.startsWith("rollout-") && ent.name.endsWith(".jsonl")) {
            const st = await fsp.stat(p);
            if (st.mtimeMs >= cutoff) rollouts.push({ file: p, mtime: st.mtimeMs });
          }
        } catch {
          // 单条目处理失败(如扫描中途文件被删致 stat 抛错):只跳过该条,
          // 不丢掉已收集的其余 rollout(此前整段 try 会让一个坏文件清空整批 Codex 项目)。
        }
      }
    };
    await walk(CODEX_SESS, 0);
    rollouts.sort((a, b) => b.mtime - a.mtime);
    await Promise.all(
      rollouts.slice(0, CODEX_MAX_FILES).map(async ({ file, mtime }) => {
        try {
          add(await readCwdFromHead(file, 16384), mtime, "codex");
        } catch {
          // 单文件容错
        }
      }),
    );
  } catch {
    // 未装 Codex
  }

  const sorted = [...map.entries()].sort((a, b) => b[1].lastActive - a[1].lastActive);
  const projects: AgentProjectInfo[] = [];
  for (const [cwd, info] of sorted) {
    if (projects.length >= MAX_PROJECTS) break;
    try {
      if (!(await fsp.stat(cwd)).isDirectory()) continue;
    } catch {
      continue; // 项目目录已删除
    }
    projects.push({ path: cwd, name: basename(cwd), agents: [...info.agents], lastActive: info.lastActive });
  }
  cache = { at: Date.now(), data: projects };
  return projects;
}

export function registerAgentProjectsHandlers(): void {
  ipcMain.handle("agents:scanProjects", () => scanAgentProjects());
}
