// 新会话落地页:中部 HomeBoard 看板 + 底部「项目·分支」条(可切项目,
// 复用 GitBar)+ 输入框(复用 ComposerShell,与会话页同一套输入能力:模型/语音/Skills/拖入)。
// 默认选最近活跃项目。选项目(或不使用项目) + 输入 → createSession(带草稿 model/skills) →
// send → 自动跳会话页。createSession 已置 homeOpen:false + activeSessionId,渲染自动切会话页。

import { useState } from "react";
import {
  DEFAULT_MODEL,
  DEFAULT_AGENT_THINKING,
  DEFAULT_NEW_SESSION_PERMISSION_MODE,
  DEFAULT_PERMISSION_MODE,
  DEFAULT_APPROVAL_POLICY,
  dayKey,
  mapThinkingForAgent,
  resolveDefaultAgent,
  useDesktopBridge,
  usePersonalActions,
  usePersonalStore,
} from "@cortex-work/core";
import type {
  AgentThinkingValue,
  AgentKind,
  ApprovalPolicy,
  DerivedAgentMeta,
  PendingDocFile,
  PendingImage,
  PermissionMode,
  PersonalAttachment,
  ProviderSettings,
  SessionMeta,
} from "@cortex-work/core";
import { HomeBoard } from "./HomeView";
import { ComposerShell } from "./ComposerShell";
import { GitBar } from "./GitBar";

// 按目标 agent 解析草稿默认 model/provider：pi 用默认 provider + 默认模型(或 provider 首模型);
// 其余内置 agent 用各自 DEFAULT_MODEL。初始化与切换 agent 共用,保证两处默认一致(R4)。
function draftDefaultsForAgent(
  base: AgentKind,
  providerSettings: ProviderSettings,
): { model: string | undefined; providerId: string | undefined } {
  if (base === "pi") {
    // 默认 provider 解析:优先 defaultProviderId,缺省/失效则回退「第一个已启用」provider
    //(与 initialModelDraft 一致)。否则 defaultProviderId 未设时会落 providerId=undefined →
    // 合并 pill 找不到匹配项,误显示「未配置供应商」(即便实际已配 provider)。
    const enabled = providerSettings.providers.filter((p) => p.enabled);
    const provider = enabled.find((p) => p.id === providerSettings.defaultProviderId) ?? enabled[0];
    // model 必须属于所选 provider:否则 `providerId::model` 在合并 pill 选项里找不到匹配 → 误显示
    // 「未配置供应商」。defaultModel 仅在它确属该 provider 时沿用,否则取该 provider 首个模型。
    const model =
      provider?.models.find((m) => m.id === providerSettings.defaultModel)?.id ?? provider?.models[0]?.id;
    return { model, providerId: provider?.id };
  }
  return { model: DEFAULT_MODEL[base], providerId: undefined };
}

export function NewSessionLanding({
  onToast,
  onOpenFlashNote,
}: {
  onToast: (text: string) => void;
  // 闪记浮层入口(壳注入,透传给 composer 图标;web/旧壳缺省 → 隐藏)。
  onOpenFlashNote?: () => void;
}) {
  const bridge = useDesktopBridge();
  const projects = usePersonalStore((s) => s.projects);
  const agentsAvailable = usePersonalStore((s) => s.agentsAvailable);
  const derivedAgents = usePersonalStore((s) => s.derivedAgents);
  const generalSettings = usePersonalStore((s) => s.generalSettings);
  const providerSettings = usePersonalStore((s) => s.providerSettings);
  const createSession = usePersonalStore((s) => s.createSession);
  const updateSession = usePersonalStore((s) => s.updateSession);
  const { send } = usePersonalActions();

  // 新会话默认「不使用项目」(selectedProjectId=undefined),可随时在 GitBar 切到具体项目。
  const [selectedProjectId, setSelectedProjectId] = useState<string | undefined>(undefined);

  // 会话尚未创建,草稿态承载输入框控件(默认 agent + 默认 model/provider),发送时落进 createSession。
  // agent 始终存内置 base;选派生时另存 derivedAgentId(发送时经 applyDraftPatch 落到新会话,spawn 端取派生 id)。
  const [draft, setDraft] = useState(() => {
    const agent = resolveDefaultAgent({ generalSettings, agentsAvailable });
    return {
      agent,
      derivedAgentId: undefined as string | undefined,
      ...draftDefaultsForAgent(agent, providerSettings),
      useOwnSkills: false,
      thinkingValue: agent === "pi" ? undefined : DEFAULT_AGENT_THINKING as AgentThinkingValue,
      permissionMode: DEFAULT_NEW_SESSION_PERMISSION_MODE as PermissionMode,
      approvalPolicy: DEFAULT_APPROVAL_POLICY as ApprovalPolicy,
    };
  });

  // 切换 agent(内置或派生):agent 落 base,派生另记 id,model/provider 按目标重置默认(R4)。
  const onChangeAgent = (a: AgentKind, derived?: DerivedAgentMeta) => {
    const base = derived?.base ?? a;
    setDraft((d) => ({
      ...d,
      agent: base,
      derivedAgentId: derived?.id,
      ...draftDefaultsForAgent(base, providerSettings),
    }));
  };

  // 把草稿态里 createSession 不直接支持的字段(derivedAgentId/providerId/useOwnSkills/permissionMode)
  // 补到新建会话上,并返回合并后的会话。关键:updateSession 只改 store 里的会话,本地 sess 引用不变;
  // 而 send 是按「传入的会话对象」解析 spawn agent / skill(见 messages.ts resolveSpawnAgentId、
  // sendSession.useOwnSkills),故必须把合并结果传给 send,否则 derivedAgentId/useOwnSkills 到不了 spawn。
  const applyDraftPatch = (sess: SessionMeta): SessionMeta => {
    const patch: Partial<SessionMeta> = {};
    if (draft.useOwnSkills) patch.useOwnSkills = true;
    // 派生 agent:落 derivedAgentId,spawn 端经 resolveSpawnAgentId 取派生 id 发给后端(R2)。
    if (draft.derivedAgentId) patch.derivedAgentId = draft.derivedAgentId;
    if (draft.agent === "pi" && draft.providerId) patch.providerId = draft.providerId;
    Object.assign(patch, mapThinkingForAgent(draft.agent, draft.thinkingValue));
    // 访问范围:非默认(full-auto 回退)才落盘。新会话默认 accept-edits,与 full-auto 不同 → 会落盘。
    if (draft.permissionMode !== DEFAULT_PERMISSION_MODE) patch.permissionMode = draft.permissionMode;
    // 执行/审批:非 auto 默认才落盘。
    if (draft.approvalPolicy !== DEFAULT_APPROVAL_POLICY) patch.approvalPolicy = draft.approvalPolicy;
    if (Object.keys(patch).length) updateSession(sess.id, patch);
    return { ...sess, ...patch };
  };

  // GitBar 据此查 git/显示分支;undefined（未选 / 不使用项目）只显示项目选择器。
  const selectedProject = projects.find((p) => p.id === selectedProjectId);

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
          return await send(sess, selectedProject.path, trimmed, attachments, undefined, images, undefined, docFiles);
        }
        // selectedProjectId 为 undefined = 不使用项目:在当天的无项目工作目录下新建会话。
        if (!bridge?.ensureNoProjectDir) {
          onToast("当前环境不支持「不使用项目」会话");
          return false;
        }
        const dir = await bridge.ensureNoProjectDir(dayKey(Date.now()));
        const sess = applyDraftPatch(createSession(undefined, draft.agent, draft.model, { noProjectDir: dir }));
        return await send(sess, dir, trimmed, attachments, undefined, images, undefined, docFiles);
      } catch (err) {
        onToast(`发送失败：${err instanceof Error ? err.message : String(err)}`);
        return false;
      }
    })();
  };

  return (
    <main className="chat pw-landing">
      <div className="pw-landing-board">
        <HomeBoard onToast={onToast} />
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
        slashCommands={[]}
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
        permissionMode={draft.permissionMode}
        onChangePermissionMode={(mode) => setDraft((d) => ({ ...d, permissionMode: mode }))}
        approvalPolicy={draft.approvalPolicy}
        onChangeApprovalPolicy={(p) => setDraft((d) => ({ ...d, approvalPolicy: p }))}
        onToggleSkills={() => setDraft((d) => ({ ...d, useOwnSkills: !d.useOwnSkills }))}
        onOpenFlashNote={onOpenFlashNote}
        onToast={onToast}
      />

      <GitBar
        project={selectedProject}
        projectValue={selectedProjectId}
        noProjectChosen
        onChangeProject={(id) => setSelectedProjectId(id)}
        running={false}
        onToast={onToast}
      />
    </main>
  );
}
