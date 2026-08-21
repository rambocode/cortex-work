// 新会话落地页:中部 HomeBoard 看板 + 输入框(复用 ComposerShell,与会话页同一套输入能力:
// 模型/语音/Skills/拖入)+ 输入框下方的项目条(ProjectBar,全应用唯一的项目选择入口)。
// 默认选最近活跃项目。选项目(或不使用项目) + 输入 → createSession(带草稿 model/skills) →
// send → 自动跳会话页。createSession 已置 homeOpen:false + activeSessionId,渲染自动切会话页。

import { useMemo, useState } from "react";
import {
  DEFAULT_MODEL,
  DEFAULT_AGENT_THINKING,
  DEFAULT_NEW_SESSION_EXEC_PERMISSION,
  DEFAULT_EXEC_PERMISSION,
  dayKey,
  mapThinkingForAgent,
  parseSkillSlash,
  resolveDefaultAgent,
  useDesktopBridge,
  usePersonalActions,
  presetSessionTitle,
  usePersonalStore,
} from "@cortex-work/core";
import type {
  AgentThinkingValue,
  AgentKind,
  DerivedAgentMeta,
  ExecPermission,
  PendingDocFile,
  PendingImage,
  PersonalAttachment,
  DefaultModelRef,
  SessionMeta,
} from "@cortex-work/core";
import {
  hasSearchBackend,
  normalizeResearchEngineSettings,
} from "@cortex-work/core/research/settings";
import { HomeBoard } from "./HomeView";
import { ComposerShell } from "../chat/composer/ComposerShell";
import { useResearchSkillAvailable, useSlashCommands } from "../chat/composer/useSlashCommands";
import {
  parseResearchSkill,
  prepareResearchDispatch,
  upsertConversationResearch,
} from "../chat/researchDispatch";
import { ProjectBar } from "../projects/ProjectBar";
import { openPanel } from "../right-panel/open";
import {
  buildConversationArtifactPrompt,
  prepareArtifactDispatch,
  upsertConversationArtifact,
} from "../chat/artifactDispatch";

// 按目标 agent 解析草稿默认 model/provider：pi 走全局 defaultModelRef(Catalog 单一引用),
// 其余内置 agent 用各自 DEFAULT_MODEL。初始化与切换 agent 共用,保证两处默认一致(R4)。
//
// pi 分支为什么只读 defaultModelRef:旧实现读 @deprecated 的 providerSettings——它在首启
// 就被主进程整体清空,导致设置页明明配好了默认模型,落地页 pill 仍恒显「未配置供应商」。
// 解析不出时返回 undefined,由合并 pill 进「未配置供应商」阻断态,**不回退**任何模型(计划 §5,
// 与 store 的 initialModelDraft 同规则)。
function draftDefaultsForAgent(
  base: AgentKind,
  defaultModelRef: DefaultModelRef | undefined,
): { model: string | undefined; providerId: string | undefined } {
  if (base === "pi") {
    return { model: defaultModelRef?.modelId, providerId: defaultModelRef?.providerId };
  }
  return { model: DEFAULT_MODEL[base], providerId: undefined };
}

export function NewSessionLanding({
  onToast,
}: {
  onToast: (text: string) => void;
}) {
  const bridge = useDesktopBridge();
  const projects = usePersonalStore((s) => s.projects);
  const agentsAvailable = usePersonalStore((s) => s.agentsAvailable);
  const derivedAgents = usePersonalStore((s) => s.derivedAgents);
  const generalSettings = usePersonalStore((s) => s.generalSettings);
  const defaultModelRef = usePersonalStore((s) => s.defaultModelRef);
  const createSession = usePersonalStore((s) => s.createSession);
  const updateSession = usePersonalStore((s) => s.updateSession);
  const { send, appendLocalUserMessage } = usePersonalActions();

  // 新会话默认「不使用项目」(selectedProjectId=undefined),可随时在 ProjectBar 切到具体项目。
  const [selectedProjectId, setSelectedProjectId] = useState<string | undefined>(undefined);

  // 会话尚未创建,草稿态承载输入框控件(默认 agent + 默认 model/provider),发送时落进 createSession。
  // agent 始终存内置 base;选派生时另存 derivedAgentId(发送时经 applyDraftPatch 落到新会话,spawn 端取派生 id)。
  const [draft, setDraft] = useState(() => {
    const agent = resolveDefaultAgent({ generalSettings, agentsAvailable });
    return {
      agent,
      derivedAgentId: undefined as string | undefined,
      ...draftDefaultsForAgent(agent, defaultModelRef),
      useOwnSkills: true, // Skills 默认打开(用户要求),可在 composer 里关
      thinkingValue: agent === "pi" ? undefined : DEFAULT_AGENT_THINKING as AgentThinkingValue,
      execPermission: DEFAULT_NEW_SESSION_EXEC_PERMISSION as ExecPermission,
      // 联网检索(默认关)。出站能力必须由用户每次显式选择,不继承任何全局默认。
      webSearch: false,
    };
  });

  // 落地页的「联网」pill 门控:与会话内 PersonalComposer 同源(有 research 子域 + 引擎已开启;
  // 搜索后端没配好则渲染但禁用)。不复用那个组件是因为落地页走草稿态、还没有 SessionMeta。
  const researchSettings = normalizeResearchEngineSettings(generalSettings.researchEngine);
  const researchAvailable = !!bridge?.research && researchSettings.enabled;
  const webSearchUnavailable = !hasSearchBackend(researchSettings);
  // 「转为深度研究」菜单项:与会话页同源,比「联网」pill 多一层深度研究档的门控。
  const researchSkillAvailable = useResearchSkillAvailable();

  // 落地页 slash:用草稿 agent/useOwnSkills + 选中项目构造最小会话对象喂 useSlashCommands
  //(usePiEnabledSkills 仅读 agent/useOwnSkills/projectId)。与会话页共用同一 hook,保证 slash 一致。
  const draftSession = useMemo(
    () => ({ agent: draft.agent, useOwnSkills: draft.useOwnSkills, projectId: selectedProjectId }) as SessionMeta,
    [draft.agent, draft.useOwnSkills, selectedProjectId],
  );
  const slashCommands = useSlashCommands(draftSession);

  // 切换 agent(内置或派生):agent 落 base,派生另记 id,model/provider 按目标重置默认(R4)。
  const onChangeAgent = (a: AgentKind, derived?: DerivedAgentMeta) => {
    const base = derived?.base ?? a;
    setDraft((d) => ({
      ...d,
      agent: base,
      derivedAgentId: derived?.id,
      ...draftDefaultsForAgent(base, defaultModelRef),
    }));
  };

  // 把草稿态里 createSession 不直接支持的字段(derivedAgentId/providerId/useOwnSkills/execPermission)
  // 补到新建会话上,并返回合并后的会话。关键:updateSession 只改 store 里的会话,本地 sess 引用不变;
  // 而 send 是按「传入的会话对象」解析 spawn agent / skill(见 messages.ts resolveSpawnAgentId、
  // sendSession.useOwnSkills),故必须把合并结果传给 send,否则 derivedAgentId/useOwnSkills 到不了 spawn。
  const applyDraftPatch = (sess: SessionMeta): SessionMeta => {
    const patch: Partial<SessionMeta> = {};
    // 始终携带草稿值(createSession 现默认 useOwnSkills=true):用户在落地页关掉时也能覆盖为 false。
    patch.useOwnSkills = draft.useOwnSkills;
    // 派生 agent:落 derivedAgentId,spawn 端经 resolveSpawnAgentId 取派生 id 发给后端(R2)。
    if (draft.derivedAgentId) patch.derivedAgentId = draft.derivedAgentId;
    if (draft.agent === "pi" && draft.providerId) patch.providerId = draft.providerId;
    Object.assign(patch, mapThinkingForAgent(draft.agent, draft.thinkingValue));
    // 执行权限:非默认(auto 回退)才落盘。新会话默认 auto,与回退同 → 通常不落盘(缺省派生即 auto)。
    if (draft.execPermission !== DEFAULT_EXEC_PERMISSION) patch.execPermission = draft.execPermission;
    // 联网检索:开启才落盘(默认关)。必须落到会话上——send 读的是 sendSession.webSearch,
    // 不落盘的话用户在落地页开的「联网」到首轮就丢了。
    if (draft.webSearch) patch.webSearch = true;
    if (Object.keys(patch).length) updateSession(sess.id, patch);
    return { ...sess, ...patch };
  };

  // 创建会话时据此拿项目 path;undefined（未选 / 不使用项目）走无项目工作目录。
  const selectedProject = projects.find((p) => p.id === selectedProjectId);

  const sendCreatedSession = async (
    sess: SessionMeta,
    cwd: string,
    text: string,
    attachments: PersonalAttachment[],
    images?: PendingImage[],
    docFiles?: PendingDocFile[],
  ): Promise<boolean> => {
    if (!bridge) return false;
    // 深度研究分叉:必须在产物分支之前。会话此刻已经建出来了,所以出错也只 toast、不回滚——
    // 用户改完目标可以在这个会话里直接重发。**不调 send**:研究不经 agent。
    // 先同步 parse 再决定要不要 await:普通消息不该为这条分叉多等一个微任务。
    if (parseResearchSkill(text)) {
      const researchDispatch = await prepareResearchDispatch(bridge, sess, text, researchSettings);
      if (researchDispatch.error) {
        onToast(researchDispatch.error);
        return false;
      }
      const ref = researchDispatch.ref!;
      updateSession(sess.id, {
        researchSessions: upsertConversationResearch(sess.researchSessions, ref),
        activeResearchSessionId: ref.sessionId,
      });
      openPanel("research");
      // 存 objective 而非原始 text:不让 /skill:research 前缀进会话流与标题(用户反馈)。
      await appendLocalUserMessage(sess, ref.objective);
      return true;
    }
    const parsed = parseSkillSlash(text);
    if (parsed?.name !== "design" && parsed?.name !== "slides") {
      return send(
        sess,
        cwd,
        text,
        attachments,
        undefined,
        images,
        undefined,
        docFiles,
      );
    }
    const dispatch = await prepareArtifactDispatch(bridge, sess, text);
    if (dispatch.error) {
      onToast(dispatch.error);
      return false;
    }
    // 标题用用户原话占位(见 presetSessionTitle):首条消息就是 skill 派发文本时,
    // 会话名会变成「/skill:design …」。
    if (dispatch.userText) presetSessionTitle(sess, dispatch.userText);
    if (dispatch.artifact) {
      updateSession(sess.id, {
        activeArtifact: dispatch.artifact,
        artifacts: upsertConversationArtifact(sess.artifacts, dispatch.artifact),
      });
      openPanel("artifact");
    }
    return send(
      sess,
      cwd,
      dispatch.outText,
      attachments,
      dispatch.artifact
        ? buildConversationArtifactPrompt(dispatch.artifact)
        : undefined,
      images,
      undefined,
      docFiles,
      dispatch.invokedSkill,
      undefined,
      dispatch.artifact,
    );
  };

  // 先 createSession 拿到 sessionId,再 await send(图片落盘在 send 内、以新 sessionId 为目录键)。
  // 纯图(无文本)允许发送。返回 send 的「已消费」结果供 composer 决定清空待发图。
  const onSubmit = (
    value: string,
    attachments: PersonalAttachment[],
    images?: PendingImage[],
    docFiles?: PendingDocFile[],
  ) => {
    const trimmed = value.trim();
    if (!trimmed && !images?.length && !docFiles?.length) return false; // 纯图/纯文档(无文本)也允许
    return (async () => {
      try {
        if (selectedProjectId) {
          // 选了具体项目:在项目目录下新建会话并发送。
          if (!selectedProject) {
            onToast("项目不存在,请重新选择");
            return false;
          }
          const sess = applyDraftPatch(createSession(selectedProjectId, draft.agent, draft.model));
          return await sendCreatedSession(
            sess,
            selectedProject.path,
            trimmed,
            attachments,
            images,
            docFiles,
          );
        }
        // selectedProjectId 为 undefined = 不使用项目:在当天的无项目工作目录下新建会话。
        if (!bridge?.ensureNoProjectDir) {
          onToast("当前环境不支持「不使用项目」会话");
          return false;
        }
        const dir = await bridge.ensureNoProjectDir(dayKey(Date.now()));
        const sess = applyDraftPatch(createSession(undefined, draft.agent, draft.model, { noProjectDir: dir }));
        return await sendCreatedSession(sess, dir, trimmed, attachments, images, docFiles);
      } catch (err) {
        onToast(`发送失败：${err instanceof Error ? err.message : String(err)}`);
        return false;
      }
    })();
  };

  return (
    <main className="chat pw-landing">
      <div className="pw-landing-board">
        <HomeBoard />
      </div>

      <ComposerShell
        agent={draft.agent}
        derivedAgentId={draft.derivedAgentId}
        derivedAgents={derivedAgents}
        agentsAvailable={agentsAvailable}
        model={draft.model}
        providerId={draft.providerId}
        useOwnSkills={draft.useOwnSkills}
        running={false}
        slashCommands={slashCommands}
        className="pw-landing-composer"
        placeholder="输入消息开启新会话,Enter 发送 · Shift+Enter 换行"
        // 订阅 composerInsert:插件「在对话中试用」在无活动会话时落到新会话落地页的输入框
        //（预填 defaultPrompt + 插件 pill,用户发送即 createSession）。与会话内 PersonalComposer 同款,
        // 二者不同时挂载,nonce 去重避免重复消费。
        acceptComposerInsert
        onSend={onSubmit}
        onChangeAgent={onChangeAgent}
        onChangeModel={(model) => setDraft((d) => ({ ...d, model }))}
        onChangePiModel={(providerId, model) => setDraft((d) => ({ ...d, providerId, model }))}
        thinkingValue={draft.thinkingValue}
        onChangeThinking={(thinkingValue) => setDraft((d) => ({ ...d, thinkingValue }))}
        execPermission={draft.execPermission}
        onChangeExecPermission={(p) => setDraft((d) => ({ ...d, execPermission: p }))}
        onToggleSkills={() => setDraft((d) => ({ ...d, useOwnSkills: !d.useOwnSkills }))}
        webSearch={draft.webSearch}
        webSearchUnavailable={webSearchUnavailable}
        researchSkillAvailable={researchSkillAvailable}
        {...(researchAvailable
          ? { onToggleWebSearch: () => setDraft((d) => ({ ...d, webSearch: !d.webSearch })) }
          : {})}
        onToast={onToast}
      />

      {/* 输入框下方的项目条:全应用唯一的项目选择入口(会话页已不展示项目/git 信息)。 */}
      <ProjectBar value={selectedProjectId} onChange={(id) => setSelectedProjectId(id)} onToast={onToast} />
    </main>
  );
}
