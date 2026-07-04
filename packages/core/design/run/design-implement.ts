// 设计 → 代码流程：把批准的设计 artifact(单文件 HTML + 设计说明 + 设计系统)交给
// 代码 agent 在**真实目标项目**里实现。与设计回合(design-run-manager)不同,实现回合
// 就是一次常规个人工作区会话——复用 SpotlightIntent handoff(建会话 + 发首条消息 + 折叠/持久化),
// 用户可继续对话迭代。设计工作区与目标项目是两个目录,故把设计产物**拷进目标项目**
// (self-contained,相对路径在目标项目内可解析、落在 fs 白名单内),再引用它们。
import type { DesktopBridge } from "../../desktop/bridge";
import type { AgentKind, ProjectMeta, SpotlightIntent } from "../../desktop/types";
import { usePersonalStore } from "../../store/personal";
import { useDesignWorkspaceStore } from "../design-workspace-store";
import { buildImplementDesignPrompt } from "../design-implement-prompt";
import { artifactDesignMdPathOf } from "../design-artifact-persistence";
import { DESIGN_SYSTEM_MD_PATH } from "../design-foundation";
import { currentDesignArtifactVersion, type DesignArtifact } from "../design-types";

// 目标项目内存放设计产物副本的目录(相对项目根)。
const IMPORT_DIR = "docs/design";

function joinAbs(root: string, rel: string): string {
  return `${root.replace(/\/+$/, "")}/${rel.replace(/^\/+/, "")}`;
}

function uid(prefix: string): string {
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

// 尝试读设计工作区里的一个相对文件;失败(不存在/无权限)返回 null。
async function readDesignFile(
  bridge: DesktopBridge,
  designRoot: string,
  rel: string,
): Promise<string | null> {
  try {
    const r = await bridge.readFile(joinAbs(designRoot, rel));
    return r.content;
  } catch {
    return null;
  }
}

export type ImplementDesignResult =
  | { ok: true; sessionPending: true }
  | { ok: false; error: string };

// 发起「用代码实现」。返回后由 SpotlightIntent handoff(PersonalWorkspace 挂载的
// useSpotlightHandoff)在 hydrate 后建会话并发送;本函数负责选目标项目、拷贝产物、
// 组装 prompt、写实现溯源。
export async function implementDesignInProject(input: {
  bridge: DesktopBridge;
  artifact: DesignArtifact;
  // 目标项目(必须已在 personal.projects 中,保证 cwd 在 fs 白名单内且会话可归属)。
  project: ProjectMeta;
}): Promise<ImplementDesignResult> {
  const { bridge, artifact, project } = input;
  const personal = usePersonalStore.getState();
  const design = useDesignWorkspaceStore.getState();
  const designRoot = design.workspaceRoot || personal.designSettings.defaultWorkspaceRoot;
  if (!designRoot) return { ok: false, error: "设计工作目录未确定" };

  const settings = personal.designSettings;
  // 当前版本的设计 HTML 与其设计说明(DESIGN.md)在设计工作区的相对路径。
  const htmlRel = currentDesignArtifactVersion(artifact)?.relativePath ?? artifact.relativePath;
  const notesRel = artifact.designMdPath ?? artifactDesignMdPathOf(htmlRel);

  const html = await readDesignFile(bridge, designRoot, htmlRel);
  if (html == null) return { ok: false, error: "读取设计 HTML 失败" };
  const notes = await readDesignFile(bridge, designRoot, notesRel);
  const designSystem = settings.publishDesignSystem
    ? await readDesignFile(bridge, designRoot, DESIGN_SYSTEM_MD_PATH)
    : null;

  // 拷进目标项目(相对路径,落在项目根白名单内;文件名以 artifact id 去重)。
  const htmlTargetRel = `${IMPORT_DIR}/${artifact.id}.html`;
  const notesTargetRel = notes != null ? `${IMPORT_DIR}/${artifact.id}.DESIGN.md` : undefined;
  const systemTargetRel = designSystem != null ? `${IMPORT_DIR}/DESIGN_SYSTEM.md` : undefined;
  try {
    await bridge.writeFile(joinAbs(project.path, htmlTargetRel), html);
    if (notesTargetRel && notes != null) await bridge.writeFile(joinAbs(project.path, notesTargetRel), notes);
    if (systemTargetRel && designSystem != null) {
      await bridge.writeFile(joinAbs(project.path, systemTargetRel), designSystem);
    }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : "拷贝设计产物到项目失败" };
  }

  // 组装实现 prompt(路径全部相对目标项目根,agent 在项目 cwd 内可解析)。
  const prompt = buildImplementDesignPrompt({
    artifactTitle: artifact.title,
    artifactRelativePath: htmlTargetRel,
    designNotesRelativePath: notesTargetRel,
    designSystemRelativePath: systemTargetRel,
    referenceDesignSystem: settings.injectIntoCode && systemTargetRel != null,
    stackHint: settings.implementStackHint,
    workspaceRoot: project.path,
    designContext: {
      designTarget: design.designContext.designTarget,
      brandColor: settings.brandColor,
      tone: settings.tone,
      designSystemPreset: settings.designSystemPreset,
      designGuidelines: settings.designGuidelines,
    },
  });

  // 经 SpotlightIntent 交给个人工作区 handoff 建会话并发送(常规编码会话,复用全部既有 UX)。
  const agent: AgentKind = personal.lastAgent ?? "claude";
  const intentId = uid("design-impl");
  const intent: SpotlightIntent = {
    id: intentId,
    prompt,
    agent,
    ...(personal.designSettings.model || personal.lastModel
      ? { model: personal.designSettings.model || personal.lastModel }
      : {}),
    projectId: project.id,
  };
  // 写实现溯源(用 intentId 作 thread 标识占位;真实 sessionId 由 handoff 生成,
  // 无跨模块回传通道,v1 以 intentId 记录"已发起实现"即可满足页卡徽标需求)。
  design.markImplemented(artifact.id, intentId);

  personal.setPendingSpotlightIntent(intent);
  // 切走设计视图,让个人工作区接管(handoff 会切到 personal workspace + 选中新会话)。
  personal.closeDesign();
  return { ok: true, sessionPending: true };
}
