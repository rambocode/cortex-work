#!/usr/bin/env node

// personal-workspace.json 被空快照覆盖后的保守恢复工具。
//
// 恢复原则：
// 1. 当前文件中的设置仍是最新值，只恢复 projects/sessions 两个索引分片；
// 2. 旧 .bak 提供当时仍有效的项目与会话，避免凭聊天正文猜测既有元数据；
// 3. .bak 之后新建且仍保留非空 chat 文件的会话视为未被正常删除，可重建最小元数据；
// 4. 正常删除会同步删除 chat 文件，因此不恢复没有正文文件的元数据；
// 5. --apply 前先原样备份当前权威文件，最终写入使用 tmp + rename 原子替换。

import { promises as fs } from "node:fs";
import { homedir } from "node:os";
import { basename, join } from "node:path";

const args = process.argv.slice(2);
const apply = args.includes("--apply");
const rootFlag = args.indexOf("--root");
const root = rootFlag >= 0 && args[rootFlag + 1] ? args[rootFlag + 1] : join(homedir(), ".cortex-desktop");
const workspacePath = join(root, "personal-workspace.json");
const legacyBackupPath = join(root, "personal-workspace.json.bak");
const chatsPath = join(root, "chats");

function messagesOf(raw) {
  if (Array.isArray(raw)) return raw;
  if (raw && typeof raw === "object" && Array.isArray(raw.messages)) return raw.messages;
  return [];
}

function subagentCallIdOf(messages) {
  const taskIds = new Set();
  for (const message of messages) {
    const uid = message?.uid;
    if (typeof uid === "string" && uid.startsWith("subagent-task-")) {
      const callId = uid.slice("subagent-task-".length);
      if (callId) taskIds.add(callId);
    }
  }
  return taskIds.size === 1 ? [...taskIds][0] : undefined;
}

function createdAtOf(id, stat) {
  const match = /^sess-([a-z0-9]+)-/.exec(id);
  if (match) {
    const decoded = Number.parseInt(match[1], 36);
    const lowerBound = Date.UTC(2020, 0, 1);
    if (Number.isFinite(decoded) && decoded >= lowerBound && decoded <= Date.now() + 86_400_000) {
      return decoded;
    }
  }
  return stat.birthtimeMs > 0 ? stat.birthtimeMs : stat.mtimeMs;
}

function inferAgent(messages, fallback) {
  const actors = new Set(messages.map((message) => message?.who));
  if (actors.has("pi")) return "pi";
  if (actors.has("codex")) return "codex";
  if (actors.has("claude")) return "claude";
  return fallback || "pi";
}

function compactTitle(value) {
  if (typeof value !== "string") return "";
  return value
    .replace(/!\[[^\]]*\]\([^)]*\)/g, "")
    .replace(/[`*_>#]/g, "")
    .replaceAll("[", "")
    .replaceAll("]", "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 48);
}

function inferTitle(messages, createdAt, childRef) {
  if (childRef) {
    const taskTitle = compactTitle(childRef.taskTitle);
    return `${childRef.roleLabel || "子代理"}${taskTitle ? ` · ${taskTitle}` : ""}`;
  }
  const firstUserText = messages.find((message) => message?.kind === "text" && message?.who === "me")?.text;
  const title = compactTitle(firstUserText);
  if (title) return title;
  const day = new Date(createdAt).toLocaleDateString("zh-CN", { timeZone: "Asia/Singapore" });
  return `恢复的会话 ${day}`;
}

function inferProjectId(messages, projects) {
  const serialized = JSON.stringify(messages);
  const matches = projects.filter(
    (project) => typeof project.path === "string" && project.path.length > 1 && serialized.includes(project.path),
  );
  return matches.length === 1 ? matches[0].id : undefined;
}

async function loadJson(path) {
  return JSON.parse(await fs.readFile(path, "utf8"));
}

async function buildRecovery() {
  const [current, backup, backupStat, files] = await Promise.all([
    loadJson(workspacePath),
    loadJson(legacyBackupPath),
    fs.stat(legacyBackupPath),
    fs.readdir(chatsPath),
  ]);
  if (!Array.isArray(current.projects) || !Array.isArray(current.sessions)) {
    throw new Error("当前 personal-workspace.json 结构无效，拒绝恢复");
  }
  if (!Array.isArray(backup.projects) || !Array.isArray(backup.sessions)) {
    throw new Error("personal-workspace.json.bak 结构无效，拒绝恢复");
  }

  const chatEntries = [];
  const childRefs = new Map();
  const cardRefsByCallId = new Map();
  for (const file of files.filter((name) => name.endsWith(".json"))) {
    const path = join(chatsPath, file);
    const [raw, stat] = await Promise.all([loadJson(path), fs.stat(path)]);
    const messages = messagesOf(raw);
    const id = basename(file, ".json");
    chatEntries.push({ id, messages, stat });
    for (const message of messages) {
      if (message?.kind !== "subagentCard") continue;
      const cardRef = {
        parentSessionId: id,
        callId: message.callId,
        roleId: message.roleId,
        roleLabel: message.roleLabel,
        taskTitle: message.taskTitle,
      };
      if (typeof message.callId === "string") cardRefsByCallId.set(message.callId, cardRef);
      if (typeof message.childSessionId === "string") childRefs.set(message.childSessionId, cardRef);
    }
  }

  // 旧父卡片没有 childSessionId 时，子聊天本身仍保留 createSubagentSession 写入的任务 UID。
  // 先用 callId 回连父卡片；若父消息也已在 HMR 事故中丢失，仍确认为 side，父级稍后只在
  // 时间窗候选唯一时补齐，绝不为了恢复导航而猜测多个可能的父会话。
  for (const entry of chatEntries) {
    if (childRefs.has(entry.id)) continue;
    const callId = subagentCallIdOf(entry.messages);
    if (!callId) continue;
    childRefs.set(entry.id, cardRefsByCallId.get(callId) ?? { callId });
  }

  const projects = backup.projects;
  const sessions = [...backup.sessions];
  const known = new Set(sessions.map((session) => session.id));
  const fallbackAgent = current.lastAgent || backup.lastAgent || "pi";
  let skippedOld = 0;
  let skippedEmpty = 0;
  let restoredPrimary = 0;
  let restoredSide = 0;

  // 先重建普通会话，随后 side 会话可继承已经恢复出的父级项目归属。
  const candidates = chatEntries
    .map((entry) => ({ ...entry, createdAt: createdAtOf(entry.id, entry.stat) }))
    .filter((entry) => !known.has(entry.id))
    .sort((left, right) => left.createdAt - right.createdAt);

  for (const entry of candidates.filter((candidate) => !childRefs.has(candidate.id))) {
    if (entry.createdAt <= backupStat.mtimeMs) {
      skippedOld += 1;
      continue;
    }
    if (entry.messages.length === 0) {
      skippedEmpty += 1;
      continue;
    }
    const projectId = inferProjectId(entry.messages, projects);
    sessions.push({
      id: entry.id,
      title: inferTitle(entry.messages, entry.createdAt),
      agent: inferAgent(entry.messages, fallbackAgent),
      ...(projectId ? { projectId } : {}),
      createdAt: entry.createdAt,
      updatedAt: Math.max(entry.createdAt, entry.stat.mtimeMs),
    });
    known.add(entry.id);
    restoredPrimary += 1;
  }

  for (const entry of candidates.filter((candidate) => childRefs.has(candidate.id))) {
    if (entry.createdAt <= backupStat.mtimeMs || entry.messages.length === 0) continue;
    const childRef = childRefs.get(entry.id);
    const explicitParent = sessions.find((session) => session.id === childRef.parentSessionId);
    const inferredParents = explicitParent ? [] : sessions.filter(
      (session) =>
        session.relation !== "side" &&
        !childRefs.has(session.id) &&
        session.createdAt <= entry.createdAt &&
        session.updatedAt >= entry.createdAt,
    );
    const parent = explicitParent ?? (inferredParents.length === 1 ? inferredParents[0] : undefined);
    sessions.push({
      id: entry.id,
      title: inferTitle(entry.messages, entry.createdAt, childRef),
      agent: inferAgent(entry.messages, parent?.agent || fallbackAgent),
      ...(parent?.projectId ? { projectId: parent.projectId } : {}),
      relation: "side",
      ...(parent ? { parentSessionId: parent.id } : {}),
      ...(childRef.callId ? { parentSubagentCallId: childRef.callId } : {}),
      createdAt: entry.createdAt,
      updatedAt: Math.max(entry.createdAt, entry.stat.mtimeMs),
    });
    known.add(entry.id);
    restoredSide += 1;
  }

  sessions.sort((left, right) => left.createdAt - right.createdAt);
  return {
    next: { ...current, projects, sessions },
    summary: {
      mode: apply ? "apply" : "dry-run",
      backupProjects: backup.projects.length,
      backupSessions: backup.sessions.length,
      restoredPrimary,
      restoredSide,
      skippedOld,
      skippedEmpty,
      finalProjects: projects.length,
      finalSessions: sessions.length,
    },
  };
}

const { next, summary } = await buildRecovery();
if (apply) {
  const backupDir = join(root, "recovery-backups");
  await fs.mkdir(backupDir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  await fs.copyFile(workspacePath, join(backupDir, `personal-workspace.before-recovery-${stamp}.json`));
  const tmp = `${workspacePath}.recovery-tmp`;
  await fs.writeFile(tmp, JSON.stringify(next, null, 2), "utf8");
  await fs.rename(tmp, workspacePath);
}
console.log(JSON.stringify(summary, null, 2));
