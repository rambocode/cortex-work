// 用户 JSON 派生/覆盖 agent(M3-A,FR-M3-1)。对标 open-design `runtimes/local-profiles.ts`。
//
// 用户在 ~/.cortex-desktop/agents.local.json 写一份声明,即可**不改代码**:
//   - 覆盖内置 agent(id 与某内置同名):换 bin / 追加参数 / 注入 env;
//   - 派生新 agent(新 id,base 指向某内置):复用该内置的 parseLine 与能力位,只换 bin/args/env。
//
// 安全姿态(与 mcp-config.ts 一致):解析失败 / 字段非法**不抛错、不阻断启动** —— 跳过非法项、
// 保留合法项、记 warn。不依赖 electron(用 os.homedir),便于单测。
//
// 文件形状(两种均接受,数组为宽松写法):
//   { "agents": [ { id, base, label?, bin?, extraArgs?, env? }, ... ] }
//   [ { id, base, ... }, ... ]

import { readFileSync } from "fs";
import { homedir } from "os";
import { join } from "path";
import type { AgentDef } from "./index";
import { createLogger } from "../log";

const log = createLogger("agent-profiles");

// 派生只能基于内置 def(它提供 parseLine 与能力位)。
export const BUILT_IN_AGENT_IDS = ["claude", "codex", "pi"] as const;
export type BuiltInAgentId = (typeof BUILT_IN_AGENT_IDS)[number];

export interface LocalAgentProfile {
  // 新 agent 的 id;与某内置同名时表示「覆盖该内置」。
  id: string;
  // 派生自哪个内置 def —— 决定 parseLine 与能力位(promptDelivery/mcpInjection/...)。
  base: BuiltInAgentId;
  // 可选展示名(供 UI 列出;不影响 spawn)。
  label?: string;
  // 覆盖可执行名 / 绝对路径(不填则沿用 base 的 cmd)。
  bin?: string;
  // 追加到 base 构造出的 args **末尾**。prompt 经 stdin 投递(claude/codex),故末尾追加 flag 安全;
  // pi 的 prompt 在 argv,extraArgs 仍追加在其后(一般 pi 不需要派生)。
  extraArgs?: string[];
  // 注入子进程环境变量(如自定义 BASE_URL / API key 占位),由 spawn 站点合并。
  env?: Record<string, string>;
}

// id 约束:小写字母数字 + 单连字符,首尾非连字符(与 pi skill 名规则一致,便于跨处统一)。
// 允许单词形态,故内置名 "claude"/"codex"/"pi" 亦合法(覆盖场景)。
function isValidAgentId(id: string): boolean {
  return /^[a-z0-9]+(-[a-z0-9]+)*$/.test(id);
}

function isStringRecord(v: unknown): v is Record<string, string> {
  if (!v || typeof v !== "object" || Array.isArray(v)) return false;
  return Object.values(v as Record<string, unknown>).every((x) => typeof x === "string");
}

function isStringArray(v: unknown): v is string[] {
  return Array.isArray(v) && v.every((x) => typeof x === "string");
}

// 校验单个条目;非法返回 null(调用方跳过 + warn)。
function validateProfile(raw: unknown): LocalAgentProfile | null {
  if (!raw || typeof raw !== "object") return null;
  const o = raw as Record<string, unknown>;
  if (typeof o.id !== "string" || !isValidAgentId(o.id)) return null;
  if (typeof o.base !== "string" || !(BUILT_IN_AGENT_IDS as readonly string[]).includes(o.base)) return null;
  const profile: LocalAgentProfile = { id: o.id, base: o.base as BuiltInAgentId };
  if (o.label !== undefined) {
    if (typeof o.label !== "string") return null;
    profile.label = o.label;
  }
  if (o.bin !== undefined) {
    if (typeof o.bin !== "string" || o.bin.trim() === "") return null;
    profile.bin = o.bin;
  }
  if (o.extraArgs !== undefined) {
    if (!isStringArray(o.extraArgs)) return null;
    profile.extraArgs = o.extraArgs;
  }
  if (o.env !== undefined) {
    if (!isStringRecord(o.env)) return null;
    profile.env = o.env;
  }
  return profile;
}

// 纯校验:把任意 JSON 值归一为合法 profile 列表。跳过非法项、按 id 去重(首项胜出)、记 warn。
export function parseLocalAgentProfiles(raw: unknown): LocalAgentProfile[] {
  const list: unknown = Array.isArray(raw)
    ? raw
    : raw && typeof raw === "object"
      ? (raw as Record<string, unknown>).agents
      : undefined;
  if (!Array.isArray(list)) return [];
  const out: LocalAgentProfile[] = [];
  const seen = new Set<string>();
  for (const entry of list) {
    const p = validateProfile(entry);
    if (!p) {
      log.warn("跳过非法 agent 条目:", JSON.stringify(entry)?.slice(0, 200));
      continue;
    }
    if (seen.has(p.id)) {
      log.warn(`重复 agent id「${p.id}」,保留首个、忽略后续`);
      continue;
    }
    seen.add(p.id);
    out.push(p);
  }
  return out;
}

// 读文件 → 解析。文件不存在(ENOENT)= 没有派生,返回 []。解析/读失败一律降级为 [](不阻断启动)。
export function readLocalAgentProfilesFile(path: string): LocalAgentProfile[] {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "ENOENT") {
      log.warn(`读取 ${path} 失败:`, (e as Error).message);
    }
    return [];
  }
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (e) {
    log.warn(`解析 ${path} 失败(非法 JSON):`, (e as Error).message);
    return [];
  }
  return parseLocalAgentProfiles(raw);
}

// 默认配置路径:~/.cortex-desktop/agents.local.json(与 paths.ts cortexHome 同根,但此处不 import
// electron,直接用 homedir,保持本模块可单测)。
export function defaultAgentProfilesPath(): string {
  return join(homedir(), ".cortex-desktop", "agents.local.json");
}

// 由一个内置 base def + 用户 profile 派生出新的 AgentDef:
//   - cmd:profile.bin 覆盖(不填沿用 base);
//   - args:base 构造结果末尾追加 profile.extraArgs;
//   - stdin / parseLine / 能力位:沿用 base(派生只改「怎么调起」,不改「怎么解析」);
//   - extraEnv:base.extraEnv 与 profile.env 合并(profile 优先),由 spawn 站点注入。
export function deriveAgentDef(base: AgentDef, profile: LocalAgentProfile): AgentDef {
  const extraEnv =
    base.extraEnv || profile.env ? { ...(base.extraEnv ?? {}), ...(profile.env ?? {}) } : undefined;
  return {
    ...base,
    id: profile.id,
    extraEnv,
    // 传输为 ws 的 base(codex):ws 路径 spawn `codex app-server` 不经 buildArgs,
    // 故 profile.bin 需同步到 serverCmd,否则自定义二进制在 ws 模式被静默忽略(RISK-7)。
    serverCmd: profile.bin ?? base.serverCmd,
    buildArgs(req, mcpArgs) {
      const built = base.buildArgs(req, mcpArgs);
      return {
        cmd: profile.bin ?? built.cmd,
        args: profile.extraArgs?.length ? [...built.args, ...profile.extraArgs] : built.args,
        stdin: built.stdin,
      };
    },
    parseLine: base.parseLine,
  };
}
