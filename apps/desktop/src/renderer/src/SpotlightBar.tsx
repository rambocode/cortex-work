import type React from "react";
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { Icon } from "@cortex-work/ui/icons";
import { useTranslation } from "@cortex-work/core/i18n";
import {
  AGENT_MODELS,
  DEFAULT_MODEL,
  DEFAULT_PROVIDER_SETTINGS,
  initialModelDraft,
  migratePiSettings,
  type AgentKind,
  type ProviderSettings,
  type ProjectMeta,
  type SpotlightIntent,
} from "@cortex-work/core";

interface Draft {
  agent: AgentKind;
  model: string | undefined;
  providerId: string | undefined;
  projectId: string | undefined; // undefined = 不使用项目
}

let nextId = 0;
function makeId(): string {
  nextId += 1;
  return `spot-${Date.now().toString(36)}-${nextId}`;
}

const AGENT_LABEL: Record<AgentKind, string> = { claude: "Claude", codex: "Codex", pi: "Pi" };

export function SpotlightBar(): React.ReactElement {
  const { t } = useTranslation("spotlight");
  const api = typeof window !== "undefined" ? window.desktopAPI : undefined;
  const [prompt, setPrompt] = useState("");
  const [projects, setProjects] = useState<ProjectMeta[]>([]);
  const [providerSettings, setProviderSettings] = useState<ProviderSettings>(DEFAULT_PROVIDER_SETTINGS);
  const [avail, setAvail] = useState<Partial<Record<AgentKind, boolean>>>({});
  const [draft, setDraft] = useState<Draft>({ agent: "claude", model: "sonnet", providerId: undefined, projectId: undefined });
  const [menuOpen, setMenuOpen] = useState(false);
  const inputRef = useRef<HTMLTextAreaElement | null>(null);
  const rootRef = useRef<HTMLDivElement | null>(null);

  // 读取持久化状态 + 探测可用性 → 算默认 draft（记忆上次 agent/model;项目默认不使用项目）。
  const refresh = useCallback(async () => {
    if (!api?.personal) return;
    try {
      const ps = await api.personal.loadState();
      const availability = await api.personal.detectAgents().catch(() => ({}) as Partial<Record<AgentKind, boolean>>);
      // 跨迁移边界：新档 providerSettings 优先,旧档 piSettings 迁移,都没有则空。
      const legacy = ps as typeof ps & {
        piSettings?: Parameters<typeof migratePiSettings>[0];
        lastPiChannelId?: string;
      };
      const provider = ps.providerSettings ?? (legacy.piSettings ? migratePiSettings(legacy.piSettings) : DEFAULT_PROVIDER_SETTINGS);
      setProjects(ps.projects ?? []);
      setProviderSettings(provider);
      setAvail(availability);
      // pi 的初始供应商/模型来自「上次用过的 → 全局 defaultModelRef」（Catalog 引用）。
      // 不再喂 providerSettings —— §5 首启即删除该字段，且旧实现有「取第一个可用供应商/模型」
      // 的静默兜底，会让 Spotlight 新建的会话用上用户没选过的模型。
      const d = initialModelDraft({
        lastAgent: ps.lastAgent,
        lastModel: ps.lastModel,
        lastProviderId: ps.lastProviderId ?? legacy.lastPiChannelId,
        agentsAvailable: availability,
        defaultModelRef: ps.defaultModelRef,
      });
      setDraft({ agent: d.agent, model: d.model, providerId: d.providerId, projectId: undefined });
    } catch {
      // 读取失败保持默认 draft。
    }
  }, [api]);

  // 挂载 + 每次窗口获得焦点（托盘再次唤起）时刷新并清空输入、聚焦。
  useEffect(() => {
    void refresh();
    const onFocus = () => {
      setPrompt("");
      setMenuOpen(false);
      void refresh();
      requestAnimationFrame(() => inputRef.current?.focus());
    };
    window.addEventListener("focus", onFocus);
    requestAnimationFrame(() => inputRef.current?.focus());
    return () => window.removeEventListener("focus", onFocus);
  }, [refresh]);

  // 窗口高度按内容实测上报（折叠/展开同理）,主进程把窗口向上长高/收回（底边固定）。
  // 用实测高度而非写死,避免窗口短于「白卡 + 投影」时,投影被窗口下边缘硬切成半透明带。
  useLayoutEffect(() => {
    if (!api?.spotlight) return;
    const h = (rootRef.current?.scrollHeight ?? 0) + 4;
    api.spotlight.resize(h);
  }, [menuOpen, api]);

  const modelOptions =
    draft.agent === "pi"
      ? (providerSettings.providers.find((p) => p.id === draft.providerId)?.models ?? []).map((m) => ({
          label: m.label ?? m.id,
          value: m.id,
        }))
      : AGENT_MODELS[draft.agent];

  function pickAgent(agent: AgentKind): void {
    if (agent === "pi") {
      const p =
        providerSettings.providers.find(
          (x) => x.id === (providerSettings.defaultProviderId ?? providerSettings.providers[0]?.id),
        ) ?? providerSettings.providers[0];
      setDraft((d) => ({ ...d, agent, providerId: p?.id, model: providerSettings.defaultModel ?? p?.models[0]?.id }));
    } else {
      setDraft((d) => ({ ...d, agent, providerId: undefined, model: DEFAULT_MODEL[agent] }));
    }
  }

  // 收起弹层并把光标交还输入框（点 New Chat 收起 / Esc / 选完配置回到打字）。
  function closeMenu(): void {
    setMenuOpen(false);
    requestAnimationFrame(() => inputRef.current?.focus());
  }

  function submit(): void {
    const text = prompt.trim();
    if (!text || !api?.spotlight) return;
    const intent: SpotlightIntent = {
      id: makeId(),
      prompt: text,
      agent: draft.agent,
      model: draft.model,
      providerId: draft.agent === "pi" ? draft.providerId : undefined,
      projectId: draft.projectId,
    };
    void api.spotlight.submit(intent);
    setPrompt("");
    setMenuOpen(false);
  }

  function onKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>): void {
    if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      submit();
    } else if (e.key === "Escape") {
      e.preventDefault();
      if (menuOpen) closeMenu();
      else api?.spotlight?.hide();
    }
  }

  const projectName = draft.projectId ? projects.find((p) => p.id === draft.projectId)?.name ?? t("projectLabel") : undefined;

  return (
    <div className="spot-root" ref={rootRef}>
      <div className="spot-bar">
        <span className="spot-logo" aria-hidden>
          <Icon.Sparkle size={20} />
        </span>
        <textarea
          ref={inputRef}
          className="spot-input"
          rows={1}
          placeholder={t("placeholder")}
          value={prompt}
          onChange={(e) => setPrompt(e.target.value)}
          onKeyDown={onKeyDown}
          onFocus={() => setMenuOpen(false)}
        />
        <button
          className={`spot-menu-btn${menuOpen ? " is-open" : ""}`}
          onClick={() => (menuOpen ? closeMenu() : setMenuOpen(true))}
          type="button"
        >
          {t("newChat")} <Icon.Chevron size={14} />
        </button>
        <button className="spot-send" onClick={submit} disabled={!prompt.trim()} type="button" aria-label={t("send")}>
          <Icon.Send size={16} />
        </button>
      </div>
      {menuOpen ? (
        <div className="spot-menu">
          <label className="spot-row">
            <span>{t("agent")}</span>
            <select
              value={draft.agent}
              onChange={(e) => pickAgent(e.target.value as AgentKind)}
            >
              {(Object.keys(AGENT_MODELS) as AgentKind[]).map((a) => (
                <option key={a} value={a} disabled={a !== "pi" && avail[a] === false}>
                  {AGENT_LABEL[a]}
                  {a !== "pi" && avail[a] === false ? t("notInstalled") : ""}
                </option>
              ))}
            </select>
          </label>
          <label className="spot-row">
            <span>{t("model")}</span>
            <select
              value={draft.model ?? ""}
              onChange={(e) => setDraft((d) => ({ ...d, model: e.target.value || undefined }))}
            >
              {modelOptions.length === 0 ? <option value="">{t("noModel")}</option> : null}
              {modelOptions.map((m) => (
                <option key={m.value} value={m.value}>
                  {m.label}
                </option>
              ))}
            </select>
          </label>
          <label className="spot-row">
            <span>{t("project")}</span>
            <select
              value={draft.projectId ?? ""}
              onChange={(e) => setDraft((d) => ({ ...d, projectId: e.target.value || undefined }))}
            >
              <option value="">{t("noProject")}</option>
              {projects
                .filter((p) => p.archivedAt == null)
                .map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name}
                  </option>
                ))}
            </select>
          </label>
          <div className="spot-menu-foot">{projectName === undefined ? t("footNoProject") : t("footProject", { name: projectName })}</div>
        </div>
      ) : null}
    </div>
  );
}
