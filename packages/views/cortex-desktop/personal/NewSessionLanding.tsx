// 新会话落地页:顶部「新会话」标签 + 中部 HomeBoard 看板 + 底部「项目·分支」条(可切项目,
// 复用 GitBar)+ 输入框(复用 ComposerShell,与会话页同一套输入能力:模型/语音/Skills/拖入)。
// 默认选最近活跃项目。选项目(或不使用项目) + 输入 → createSession(带草稿 model/skills) →
// send → 自动跳会话页。createSession 已置 homeOpen:false + activeSessionId,渲染自动切会话页。

import { useState } from "react";
import {
  DEFAULT_MODEL,
  dayKey,
  defaultAgent,
  latestActiveProjectId,
  useDesktopBridge,
  usePersonalActions,
  usePersonalStore,
} from "@cortex-work/core";
import type { PersonalAttachment, SessionMeta } from "@cortex-work/core";
import { HomeBoard } from "./HomeView";
import { ComposerShell } from "./ComposerShell";
import { GitBar } from "./GitBar";

export function NewSessionLanding({ onToast }: { onToast: (text: string) => void }) {
  const bridge = useDesktopBridge();
  const projects = usePersonalStore((s) => s.projects);
  const sessions = usePersonalStore((s) => s.sessions);
  const agentsAvailable = usePersonalStore((s) => s.agentsAvailable);
  const piSettings = usePersonalStore((s) => s.piSettings);
  const createSession = usePersonalStore((s) => s.createSession);
  const updateSession = usePersonalStore((s) => s.updateSession);
  const { send } = usePersonalActions();

  // 默认选最近活跃会话所属项目;hasChosen 区分「未选」与「显式选了不使用项目」。
  const [selectedProjectId, setSelectedProjectId] = useState<string | undefined>(() =>
    latestActiveProjectId(sessions),
  );
  const [hasChosen, setHasChosen] = useState(false);

  // 会话尚未创建,草稿态承载输入框控件(默认 agent + 默认 model/通道),发送时落进 createSession。
  const [draft, setDraft] = useState(() => {
    const agent = defaultAgent(agentsAvailable);
    const piChannel = piSettings.channels.find((c) => c.id === piSettings.defaultChannelId);
    return {
      agent,
      model: agent === "pi" ? piSettings.defaultModel ?? piChannel?.models[0]?.id : DEFAULT_MODEL[agent],
      piChannelId: agent === "pi" ? piSettings.defaultChannelId : undefined,
      useOwnSkills: false,
    };
  });

  // 把草稿态里 createSession 不直接支持的字段(piChannelId/useOwnSkills)补到新建会话上。
  const applyDraftPatch = (sess: SessionMeta) => {
    const patch: Partial<SessionMeta> = {};
    if (draft.useOwnSkills) patch.useOwnSkills = true;
    if (draft.agent === "pi" && draft.piChannelId) patch.piChannelId = draft.piChannelId;
    if (Object.keys(patch).length) updateSession(sess.id, patch);
  };

  // GitBar 据此查 git/显示分支;undefined（未选 / 不使用项目）只显示项目选择器。
  const selectedProject = projects.find((p) => p.id === selectedProjectId);

  const onSubmit = (value: string, attachments: PersonalAttachment[]) => {
    const trimmed = value.trim();
    if (!trimmed) return;
    void (async () => {
      try {
        if (selectedProjectId) {
          // 选了具体项目:在项目目录下新建会话并发送。
          if (!selectedProject) {
            onToast("项目不存在,请重新选择");
            return;
          }
          const sess = createSession(selectedProjectId, draft.agent, draft.model);
          applyDraftPatch(sess);
          await send(sess, selectedProject.path, trimmed, attachments);
          return;
        }
        // selectedProjectId 为 undefined:仅当用户显式选了「不使用项目」或工作区为空时才放行。
        if (hasChosen || projects.length === 0) {
          if (!bridge?.ensureNoProjectDir) {
            onToast("当前环境不支持「不使用项目」会话");
            return;
          }
          const dir = await bridge.ensureNoProjectDir(dayKey(Date.now()));
          const sess = createSession(undefined, draft.agent, draft.model, { noProjectDir: dir });
          applyDraftPatch(sess);
          await send(sess, dir, trimmed, attachments);
          return;
        }
        // 有项目但未选:提示用户先选择。
        onToast("请先选择项目，或选「不使用项目」");
      } catch (err) {
        onToast(`发送失败：${err instanceof Error ? err.message : String(err)}`);
      }
    })();
  };

  return (
    <main className="chat pw-landing">
      <header className="pw-landing-bar">
        <span className="pw-landing-bar-label">新会话</span>
      </header>

      <div className="pw-landing-board">
        <HomeBoard onToast={onToast} />
      </div>

      <ComposerShell
        agent={draft.agent}
        model={draft.model}
        piChannelId={draft.piChannelId}
        useOwnSkills={draft.useOwnSkills}
        running={false}
        slashCommands={[]}
        className="pw-landing-composer"
        placeholder="输入消息开启新会话,Enter 发送 · Shift+Enter 换行"
        onSend={onSubmit}
        onChangeModel={(model) => setDraft((d) => ({ ...d, model }))}
        onChangePiModel={(channelId, model) => setDraft((d) => ({ ...d, piChannelId: channelId, model }))}
        onToggleSkills={() => setDraft((d) => ({ ...d, useOwnSkills: !d.useOwnSkills }))}
        onToast={onToast}
      />

      <GitBar
        project={selectedProject}
        projectValue={selectedProjectId}
        onChangeProject={(id) => {
          setSelectedProjectId(id);
          setHasChosen(true);
        }}
        running={false}
        onToast={onToast}
      />
    </main>
  );
}
