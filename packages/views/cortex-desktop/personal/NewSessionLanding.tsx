// 新会话落地页:中部 HomeBoard 看板 + 底部「项目·分支」条(可切项目,
// 复用 GitBar)+ 输入框(复用 ComposerShell,与会话页同一套输入能力:模型/语音/Skills/拖入)。
// 默认选最近活跃项目。选项目(或不使用项目) + 输入 → createSession(带草稿 model/skills) →
// send → 自动跳会话页。createSession 已置 homeOpen:false + activeSessionId,渲染自动切会话页。

import { useState } from "react";
import {
  DEFAULT_MODEL,
  DEFAULT_NEW_SESSION_PERMISSION_MODE,
  DEFAULT_PERMISSION_MODE,
  dayKey,
  resolveDefaultAgent,
  useDesktopBridge,
  usePersonalActions,
  usePersonalStore,
} from "@cortex-work/core";
import type { PendingImage, PermissionMode, PersonalAttachment, SessionMeta } from "@cortex-work/core";
import { HomeBoard } from "./HomeView";
import { ComposerShell } from "./ComposerShell";
import { GitBar } from "./GitBar";

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
  const generalSettings = usePersonalStore((s) => s.generalSettings);
  const providerSettings = usePersonalStore((s) => s.providerSettings);
  const createSession = usePersonalStore((s) => s.createSession);
  const updateSession = usePersonalStore((s) => s.updateSession);
  const { send } = usePersonalActions();

  // 新会话默认「不使用项目」(selectedProjectId=undefined),可随时在 GitBar 切到具体项目。
  const [selectedProjectId, setSelectedProjectId] = useState<string | undefined>(undefined);

  // 会话尚未创建,草稿态承载输入框控件(默认 agent + 默认 model/provider),发送时落进 createSession。
  const [draft, setDraft] = useState(() => {
    const agent = resolveDefaultAgent({ generalSettings, agentsAvailable });
    const provider = providerSettings.providers.find((p) => p.id === providerSettings.defaultProviderId);
    return {
      agent,
      model: agent === "pi" ? providerSettings.defaultModel ?? provider?.models[0]?.id : DEFAULT_MODEL[agent],
      providerId: agent === "pi" ? providerSettings.defaultProviderId : undefined,
      useOwnSkills: false,
      permissionMode: DEFAULT_NEW_SESSION_PERMISSION_MODE as PermissionMode,
    };
  });

  // 把草稿态里 createSession 不直接支持的字段(providerId/useOwnSkills)补到新建会话上。
  const applyDraftPatch = (sess: SessionMeta) => {
    const patch: Partial<SessionMeta> = {};
    if (draft.useOwnSkills) patch.useOwnSkills = true;
    if (draft.agent === "pi" && draft.providerId) patch.providerId = draft.providerId;
    // 仅非默认档位才落盘(缺省 full-auto 由 DEFAULT_PERMISSION_MODE 回退,保持 SessionMeta 干净)。
    if (draft.permissionMode !== DEFAULT_PERMISSION_MODE) patch.permissionMode = draft.permissionMode;
    if (Object.keys(patch).length) updateSession(sess.id, patch);
  };

  // GitBar 据此查 git/显示分支;undefined（未选 / 不使用项目）只显示项目选择器。
  const selectedProject = projects.find((p) => p.id === selectedProjectId);

  // 先 createSession 拿到 sessionId,再 await send(图片落盘在 send 内、以新 sessionId 为目录键)。
  // 纯图(无文本)允许发送。返回 send 的「已消费」结果供 composer 决定清空待发图。
  const onSubmit = (value: string, attachments: PersonalAttachment[], images?: PendingImage[]) => {
    const trimmed = value.trim();
    if (!trimmed && !images?.length) return false;
    return (async () => {
      try {
        if (selectedProjectId) {
          // 选了具体项目:在项目目录下新建会话并发送。
          if (!selectedProject) {
            onToast("项目不存在,请重新选择");
            return false;
          }
          const sess = createSession(selectedProjectId, draft.agent, draft.model);
          applyDraftPatch(sess);
          return await send(sess, selectedProject.path, trimmed, attachments, undefined, images);
        }
        // selectedProjectId 为 undefined = 不使用项目:在当天的无项目工作目录下新建会话。
        if (!bridge?.ensureNoProjectDir) {
          onToast("当前环境不支持「不使用项目」会话");
          return false;
        }
        const dir = await bridge.ensureNoProjectDir(dayKey(Date.now()));
        const sess = createSession(undefined, draft.agent, draft.model, { noProjectDir: dir });
        applyDraftPatch(sess);
        return await send(sess, dir, trimmed, attachments, undefined, images);
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
        onChangeModel={(model) => setDraft((d) => ({ ...d, model }))}
        onChangePiModel={(providerId, model) => setDraft((d) => ({ ...d, providerId, model }))}
        onToggleSkills={() => setDraft((d) => ({ ...d, useOwnSkills: !d.useOwnSkills }))}
        onOpenFlashNote={onOpenFlashNote}
        onToast={onToast}
      />

      <GitBar
        project={selectedProject}
        projectValue={selectedProjectId}
        noProjectChosen
        onChangeProject={(id) => setSelectedProjectId(id)}
        permissionMode={draft.permissionMode}
        onChangeMode={(mode) => setDraft((d) => ({ ...d, permissionMode: mode }))}
        running={false}
        onToast={onToast}
      />
    </main>
  );
}
