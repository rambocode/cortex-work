// 闪记浮层渲染入口:独立 BrowserWindow 的裸 React root,**不包 CoreProvider/QueryClient**。
// KTD10:严禁在浮层用 React Query hook 或 usePersonalStore,只能 window.desktopAPI 直连。
// 默认归属/空内容守卫复用 @cortex-work/core/personal/notes 的纯函数(无 React 依赖,不触发 hook)。
//
// 焦点契约(KTD2/R2):浮层侧 v1 统一 hide 即可——窗口图标入口的还焦 composer 若需主进程
// 配合后置;全局热键入口只保证浮层关闭,焦点归还交 OS(best-effort)。

import type React from "react";
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import ReactDOM from "react-dom/client";
import { Icon } from "@cortex-work/ui/icons";
import type { ProjectMeta } from "@cortex-work/core";
import { noteContentToSubmit, resolveDefaultNoteProject } from "@cortex-work/core/personal/notes";
// i18next 单例:本浮层是独立渲染进程(裸 React root,无 CoreProvider),import 即 init
// 本进程默认 zh 单例,使 useTranslation 可解析;跨进程语言一致由主进程 app:locale 广播驱动。
import { changeLanguage, useTranslation } from "@cortex-work/core/i18n";
import "./notes-overlay.css";

// 「未归类」option 的稳定占位 value(空串无法区分「未选」与「显式未归类」,故用专用 sentinel)。
const UNASSIGNED = "__unassigned__";

function NotesOverlay(): React.ReactElement {
  const { t } = useTranslation("notes");
  const api = typeof window !== "undefined" ? window.desktopAPI : undefined;
  const [text, setText] = useState("");
  const [projects, setProjects] = useState<ProjectMeta[]>([]);
  // undefined = 未归类。受控下拉用 UNASSIGNED 占位映射。
  const [projectId, setProjectId] = useState<string | undefined>(undefined);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const rootRef = useRef<HTMLDivElement | null>(null);
  const inputRef = useRef<HTMLTextAreaElement | null>(null);

  // 读持久化态推默认归属:浮层只能拿到 loadState() 的 lastActiveProjectId(activeProjectId/
  // 当前会话是主窗口瞬态 Zustand,不进 PersistedState,浮层读不到),故 currentSession/active
  // 均缺省,由 resolveDefaultNoteProject 回落到 lastActiveProjectId 并校验仍在 projects 中。
  const refresh = useCallback(async () => {
    if (!api?.personal) return;
    try {
      const ps = await api.personal.loadState();
      const list = ps.projects ?? [];
      setProjects(list);
      setProjectId(
        resolveDefaultNoteProject({
          lastActiveProjectId: ps.lastActiveProjectId,
          projects: list,
        }),
      );
    } catch {
      // 读取失败保持未归类默认。
      setProjects([]);
      setProjectId(undefined);
    }
  }, [api]);

  // 挂载 + 每次窗口获得焦点(热键/图标再次唤起)时:清空输入、清错、刷新默认归属、聚焦。
  useEffect(() => {
    const onFocus = () => {
      setText("");
      setError(null);
      void refresh();
      requestAnimationFrame(() => inputRef.current?.focus());
    };
    void refresh();
    window.addEventListener("focus", onFocus);
    requestAnimationFrame(() => inputRef.current?.focus());
    // 订阅主进程 locale 广播:用户在主窗口切语言时本浮层(独立 i18next 单例)随之重译。
    const offLocale = api?.personal?.onLocaleChange?.((locale) => void changeLanguage(locale));
    return () => {
      window.removeEventListener("focus", onFocus);
      offLocale?.();
    };
  }, [refresh, api]);

  // 窗口高度按内容实测上报,主进程夹取后向上长高/收回(底边固定)。仿 SpotlightBar 实测上报,
  // 避免窗口短于「白卡 + 投影」时投影被窗口下边缘硬切成半透明带。
  useLayoutEffect(() => {
    if (!api?.notesOverlay) return;
    const h = (rootRef.current?.scrollHeight ?? 0) + 4;
    api.notesOverlay.resize(h);
  }, [text, error, api]);

  const submit = useCallback(async () => {
    if (!api?.personal || saving) return;
    // 空内容守卫:不创建、浮层保持打开(仿 SpotlightBar.submit)。
    const content = noteContentToSubmit(text);
    if (!content) return;
    setSaving(true);
    setError(null);
    try {
      // 闪记仅写入 notes store,不进任何会话上下文(R14/R15)。浮层无当前会话上下文,
      // 故 sourceSessionId 不传(未来若由主窗口图标入口透传会话 id,可在此补)。
      await api.personal.notesAdd({ projectId, content });
      // 成功才关闭 + 焦点契约(v1 浮层侧统一 hide,还焦交 OS / 后续主进程配合)。
      api.notesOverlay?.hide();
    } catch {
      // 失败浮层不关、保留草稿、就地报错可重试。
      setError(t("overlay.saveFailed"));
    } finally {
      setSaving(false);
    }
  }, [api, saving, text, projectId, t]);

  function onKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>): void {
    if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      void submit();
    } else if (e.key === "Escape") {
      // Esc 关闭(与主进程 blur 自隐双保险)。
      e.preventDefault();
      api?.notesOverlay?.hide();
    }
  }

  const visibleProjects = projects.filter((p) => p.archivedAt == null);

  return (
    <div className="note-root" ref={rootRef}>
      <div className="note-card">
        <textarea
          ref={inputRef}
          className="note-input"
          rows={3}
          placeholder={t("overlay.placeholder")}
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={onKeyDown}
        />
        <div className="note-foot">
          <span className="note-foot-label" aria-hidden>
            <Icon.Pin size={13} />
          </span>
          <select
            className="note-project"
            value={projectId ?? UNASSIGNED}
            onChange={(e) => setProjectId(e.target.value === UNASSIGNED ? undefined : e.target.value)}
          >
            <option value={UNASSIGNED}>{t("overlay.unassigned")}</option>
            {visibleProjects.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
          <span className="note-foot-spacer" />
          {error ? <span className="note-error">{error}</span> : null}
          <button
            className="note-save"
            onClick={() => void submit()}
            disabled={!text.trim() || saving}
            type="button"
            aria-label={t("overlay.saveAria")}
          >
            <Icon.Send size={15} />
          </button>
        </div>
      </div>
    </div>
  );
}

ReactDOM.createRoot(document.getElementById("root")!).render(<NotesOverlay />);
