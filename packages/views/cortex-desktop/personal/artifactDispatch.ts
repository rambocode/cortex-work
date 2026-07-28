import {
  parseSkillSlash,
  renderSkillInvocation,
  resolveArtifactTarget,
} from "@cortex-work/core";
import type {
  ConversationArtifactKind,
  ConversationArtifactRef,
  DesktopBridge,
  SessionMeta,
} from "@cortex-work/core";

function artifactTitle(kind: ConversationArtifactKind, args: string): string {
  const firstLine = args.trim().split(/\r?\n/, 1)[0]?.trim();
  if (firstLine) return firstLine.slice(0, 48);
  return kind === "slides" ? "新演示文稿" : "新设计稿";
}

function artifactKey(artifact: ConversationArtifactRef): string {
  return `${artifact.workspaceRoot}\u0000${artifact.documentId}`;
}

export function upsertConversationArtifact(
  artifacts: ConversationArtifactRef[] | undefined,
  artifact: ConversationArtifactRef,
): ConversationArtifactRef[] {
  const key = artifactKey(artifact);
  const next = [...(artifacts ?? [])];
  const index = next.findIndex((candidate) => artifactKey(candidate) === key);
  if (index === -1) next.push(artifact);
  else next[index] = artifact;
  return next;
}

export function conversationArtifacts(session: SessionMeta): ConversationArtifactRef[] {
  return session.activeArtifact
    ? upsertConversationArtifact(session.artifacts, session.activeArtifact)
    : [...(session.artifacts ?? [])];
}

export function buildConversationArtifactPrompt(artifact: ConversationArtifactRef): string {
  return [
    "## 当前会话产物",
    `类型:${artifact.kind}`,
    `文稿 ID:${artifact.documentId}`,
    `工作区根:${artifact.workspaceRoot}`,
    `入口:${artifact.entryPath}`,
    "本轮必须直接读取并修改这个产物，不要另建独立工作区或切换到其它文稿。",
  ].join("\n");
}

export interface ArtifactDispatch {
  artifact?: ConversationArtifactRef;
  created?: boolean;
  handledSkill: boolean;
  outText: string;
  /**
   * 用户原话(skill 参数),仅在本条被 skill 派发消费时有值。
   *
   * 给会话标题用:outText 是发给 agent 的文本 —— pi 是 `/skill:design …`、claude 是
   * 「请使用 skill「design」…」的 prose,两种拿去派生标题都会把派发指令搬进标题栏(实测)。
   */
  userText?: string;
  invokedSkill?: { name: string; path: string };
  error?: string;
}

export async function prepareArtifactDispatch(
  bridge: DesktopBridge,
  session: SessionMeta,
  text: string,
): Promise<ArtifactDispatch> {
  const parsed = parseSkillSlash(text);
  const kind =
    parsed?.name === "design" || parsed?.name === "slides"
      ? parsed.name
      : undefined;
  if (!kind || !parsed) {
    return {
      handledSkill: false,
      outText: text,
      ...(session.activeArtifact ? { artifact: session.activeArtifact } : {}),
    };
  }
  if (!bridge.artifactCreate) {
    return { handledSkill: true, outText: text, error: "当前客户端不支持会话产物" };
  }

  let artifact = session.activeArtifact;
  let created = false;
  const target = resolveArtifactTarget(kind, artifact);
  if (target.mode === "create") {
    const result = await bridge.artifactCreate({
      kind,
      title: artifactTitle(kind, parsed.args),
      ...(session.projectId ? { projectId: session.projectId } : {}),
    });
    if (!result.ok) return { handledSkill: true, outText: text, error: result.error };
    artifact = result.artifact;
    created = true;
  } else if (artifact && bridge.artifactValidate) {
    const checked = await bridge.artifactValidate(artifact);
    if (!checked.ok) return { handledSkill: true, outText: text, error: checked.error };
  }

  const meta = await bridge.builtinSkillGet?.(kind) ?? await bridge.skillGet?.(kind);
  const skill = meta
    ? { name: meta.name, description: meta.description, dir: meta.dir }
    : null;
  let outText = parsed.args;
  if (skill && session.agent === "pi") {
    outText = parsed.args ? `/skill:${kind} ${parsed.args}` : `/skill:${kind}`;
  } else if (skill && session.agent !== "codex") {
    outText = renderSkillInvocation(
        skill,
        parsed.args || (kind === "slides" ? "创建一份演示文稿" : "创建一份设计稿"),
    );
  }
  return {
    handledSkill: true,
    outText,
    ...(parsed.args.trim() ? { userText: parsed.args.trim() } : {}),
    artifact,
    ...(created ? { created: true } : {}),
    ...((session.agent === "codex" || session.agent === "pi") && skill
      ? { invokedSkill: { name: skill.name, path: skill.dir } }
      : {}),
  };
}
