// 用户记忆设置分区：查看/编辑三分区记忆（手写区 + 做梦自动整理区）、记忆总开关、
// 「立即整理」、清除、打开数据文件夹、做梦历史。
// 数据流：真源在 main 侧 ~/.cortex-desktop/memory/*.md;本组件读 useMemoryStore 只读缓存,
// 编辑时乐观更新缓存 + 防抖 400ms 写真源（模式平移 ReplySettingsSection 的 MemoryManager）。
// Web/旧壳（bridge 无 memoryGet）由 SettingsMenu 侧过滤隐藏整个入口,此处不再守卫。

import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { useDesktopBridge } from "@cortex-work/core/provider";
import { usePersonalStore } from "@cortex-work/core/store/personal";
import { useMemoryStore } from "@cortex-work/core/store/memory";
import {
  USER_MEMORY_SCOPES,
  type DreamStateSummary,
  type UserMemoryFile,
  type UserMemoryScope,
} from "@cortex-work/core/memory/memory";
import { SettingCard, SRow } from "./settingsControls";
import { ResearchMemoryCandidates } from "./ResearchMemoryCandidates";

// 译函数最小签名（与 SettingsMenu 一致,避免引入 react-i18next 的 TFunction 泛型）。
type TFunction = (key: string, opts?: Record<string, unknown>) => string;

// 分区 → i18n label（顺序与 USER_MEMORY_SCOPES 一致）。
function scopeLabel(t: TFunction, scope: UserMemoryScope): string {
  return t(`memory.scope.${scope}`);
}

// 时间戳 → 本地化短时间（做梦历史/上次整理展示;当天只显示时分,跨天带日期）。
function formatDreamTime(ts: number): string {
  const d = new Date(ts);
  const now = new Date();
  const sameDay = d.toDateString() === now.toDateString();
  const hm = d.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
  return sameDay ? hm : `${d.toLocaleDateString()} ${hm}`;
}

/**
 * 做梦整理卡片：立即整理按钮 + 上次整理时间 + 最近历史。
 * dreamState 经 bridge.memoryGetDreamState 拉取（挂载时 + 每次整理完成后刷新）。
 */
function DreamCard() {
  const { t } = useTranslation("settings");
  const bridge = useDesktopBridge();
  const dreamState = useMemoryStore((s) => s.dreamState);
  const hydrateDreamState = useMemoryStore((s) => s.hydrateDreamState);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);

  const refreshState = useCallback(() => {
    void bridge
      ?.memoryGetDreamState?.()
      .then((state: DreamStateSummary) => hydrateDreamState(state))
      .catch(() => {});
  }, [bridge, hydrateDreamState]);

  useEffect(() => refreshState(), [refreshState]);

  // 手动「立即整理」：单飞（进行中返回 in-flight）,结果以一行小字反馈。
  const handleDreamNow = useCallback(async () => {
    if (!bridge?.memoryDreamNow || busy) return;
    setBusy(true);
    setMsg(null);
    try {
      const result = await bridge.memoryDreamNow();
      if (result.ok) {
        setMsg(
          result.sessionsScanned === 0
            ? t("memory.dreamNothingNew")
            : t("memory.dreamDone", { sessions: result.sessionsScanned ?? 0, scopes: result.learnedScopes ?? 0 }),
        );
      } else if (result.error === "in-flight") {
        setMsg(t("memory.dreamInFlight"));
      } else if (result.error === "disabled") {
        setMsg(t("memory.dreamDisabled"));
      } else if (result.error?.includes("模型未配置") || result.error === "model-not-configured") {
        setMsg(t("memory.dreamNoModel"));
      } else {
        setMsg(t("memory.dreamFailed", { detail: result.error ?? "" }));
      }
    } catch {
      setMsg(t("memory.dreamFailed", { detail: "" }));
    } finally {
      setBusy(false);
      refreshState();
    }
  }, [bridge, busy, t, refreshState]);

  return (
    <SettingCard title={t("memory.dreamCard")}>
      <SRow
        label={t("memory.dreamNowLabel")}
        desc={
          dreamState?.lastDreamAt
            ? t("memory.lastDreamAt", { time: formatDreamTime(dreamState.lastDreamAt) })
            : t("memory.neverDreamed")
        }
        end
      >
        <button type="button" className="pw-btn-sm" disabled={busy} onClick={() => void handleDreamNow()}>
          {busy ? t("memory.dreamBusy") : t("memory.dreamNow")}
        </button>
      </SRow>
      {msg ? <div className="pw-srow-desc">{msg}</div> : null}
      {/* 最近做梦历史（成功/失败、触发来源、消化会话数） */}
      {dreamState?.history?.length ? (
        <div className="pw-memory-history">
          {dreamState.history.slice(0, 5).map((rec, i) => (
            <div key={`${rec.at}-${i}`} className="pw-srow-desc">
              {formatDreamTime(rec.at)} · {t(`memory.trigger.${rec.trigger}`)} ·{" "}
              {rec.ok
                ? t("memory.historyOk", { sessions: rec.sessionsScanned, scopes: rec.learnedScopes })
                : t("memory.historyFailed")}
            </div>
          ))}
        </div>
      ) : null}
    </SettingCard>
  );
}

export function MemorySettingsSection() {
  const { t } = useTranslation("settings");
  const bridge = useDesktopBridge();
  const memory = useMemoryStore((s) => s.memory);
  const setMemoryFile = useMemoryStore((s) => s.setMemoryFile);
  const clearAllMemory = useMemoryStore((s) => s.clearAllMemory);
  const clearAutoMemory = useMemoryStore((s) => s.clearAutoMemory);
  const memoryEnabled = usePersonalStore((s) => s.generalSettings.memoryEnabled !== false);
  const setGeneralSettings = usePersonalStore((s) => s.setGeneralSettings);

  // 编辑落盘：本地缓存即时更新保证输入流畅;真源写入按「分区+字段」防抖 400ms 合并连续击键,
  // 卸载时冲刷未落盘的最后一笔（模式与 reply MemoryManager 一致）。
  const pendingWrites = useRef(new Map<string, { scope: UserMemoryScope; patch: Partial<UserMemoryFile> }>());
  const writeTimers = useRef(new Map<string, ReturnType<typeof setTimeout>>());
  const updateMemoryFile = useCallback(
    (targetScope: UserMemoryScope, patch: Partial<UserMemoryFile>) => {
      setMemoryFile(targetScope, patch);
      if (!bridge?.memorySetFile) return;
      const key = `${targetScope}:${Object.keys(patch).join(",")}`;
      pendingWrites.current.set(key, { scope: targetScope, patch });
      const existing = writeTimers.current.get(key);
      if (existing) clearTimeout(existing);
      writeTimers.current.set(
        key,
        setTimeout(() => {
          writeTimers.current.delete(key);
          const pending = pendingWrites.current.get(key);
          pendingWrites.current.delete(key);
          if (pending) void bridge.memorySetFile?.(pending.scope, pending.patch);
        }, 400),
      );
    },
    [bridge, setMemoryFile],
  );
  useEffect(
    () => () => {
      // 卸载冲刷：清计时器并把未发送的最后一笔立即写真源。
      for (const timer of writeTimers.current.values()) clearTimeout(timer);
      writeTimers.current.clear();
      for (const { scope: s, patch } of pendingWrites.current.values()) {
        void bridge?.memorySetFile?.(s, patch);
      }
      pendingWrites.current.clear();
    },
    [bridge],
  );

  // 当前编辑的记忆分区（本地 UI 态,默认用户画像）。
  const [scope, setScope] = useState<UserMemoryScope>("profile");
  const file = memory[scope];

  // 清除：先写真源再更新本地缓存（清除是低频破坏性操作,不走乐观+防抖）。
  const handleClear = useCallback(
    (kind: "all" | "auto") => {
      const confirmed = window.confirm(kind === "all" ? t("memory.clearAllConfirm") : t("memory.clearAutoConfirm"));
      if (!confirmed) return;
      void bridge?.memoryClear?.(kind).then(() => {
        if (kind === "all") clearAllMemory();
        else clearAutoMemory();
      });
    },
    [bridge, clearAllMemory, clearAutoMemory, t],
  );

  return (
    <>
      <div className="pw-dlg-title">{t("memory.title")}</div>
      <div className="pw-dlg-desc">{t("memory.desc")}</div>

      {/* 记忆总开关：关闭后不再注入任何工作台 prompt,主进程做梦管线也停跑。 */}
      <SettingCard title={t("memory.switchCard")}>
        <SRow label={t("memory.enabledLabel")} desc={t("memory.enabledDesc")} end>
          <button
            type="button"
            className="twk-toggle"
            data-on={memoryEnabled ? "1" : "0"}
            role="switch"
            aria-checked={memoryEnabled}
            aria-label={t("memory.enabledLabel")}
            onClick={() => setGeneralSettings({ memoryEnabled: !memoryEnabled })}
          >
            <i />
          </button>
        </SRow>
      </SettingCard>

      {/* 分区内容卡片：分区切换 + 自动整理区（可编辑校正）+ 手写区（优先级最高） */}
      <div className="pw-scard">
        <div className="pw-scard-t">{t("memory.contentCard")}</div>
        <div className="pw-srow-desc">{t("memory.contentDesc")}</div>

        {/* 分区切换（复用 reply 的 segmented 样式类） */}
        <div className="pw-reply-scopes" role="tablist" aria-label={t("memory.contentCard")}>
          {USER_MEMORY_SCOPES.map((s) => (
            <button
              key={s}
              type="button"
              role="tab"
              aria-selected={s === scope}
              className={`pw-reply-scope ${s === scope ? "is-active" : ""}`}
              onClick={() => setScope(s)}
            >
              {scopeLabel(t, s)}
            </button>
          ))}
        </div>

        {/* 手写区：用户直接维护,注入 prompt 时标注优先级最高 */}
        <label className="pw-set-field">
          <span className="pw-set-lbl">{t("memory.manualLabel")}</span>
          <textarea
            className="pw-ta pw-reply-memo"
            rows={5}
            value={file.manual}
            placeholder={t("memory.manualPlaceholder")}
            onChange={(e) => updateMemoryFile(scope, { manual: e.target.value })}
          />
        </label>

        {/* 自动整理区：做梦管线写入,也允许用户手动校正/删除个别条目 */}
        <label className="pw-set-field">
          <span className="pw-set-lbl">{t("memory.autoLabel")}</span>
          <textarea
            className="pw-ta pw-reply-memo"
            rows={6}
            value={file.auto}
            placeholder={t("memory.autoEmpty")}
            onChange={(e) => updateMemoryFile(scope, { auto: e.target.value })}
          />
        </label>
      </div>

      {/* 做梦整理：立即整理 + 上次时间 + 历史 */}
      <DreamCard />

      {/* 研究记忆候选（U10）：KTD10 那道「逐条批准」闸的人机界面。
          桥不支持时组件自己返回 null，这里不必再 gate 一次。 */}
      <ResearchMemoryCandidates />

      {/* 数据管理：打开文件夹 / 清自动区 / 清全部 */}
      <SettingCard title={t("memory.dataCard")}>
        <SRow label={t("memory.dataFilesLabel")} desc={t("memory.dataFilesDesc")} end>
          <button type="button" className="pw-btn-sm" onClick={() => void bridge?.memoryOpenFolder?.()}>
            {t("memory.openFolder")}
          </button>
        </SRow>
        <SRow label={t("memory.clearLabel")} desc={t("memory.clearDesc")} end>
          <div className="pw-memory-clear-actions">
            <button type="button" className="pw-btn-sm" onClick={() => handleClear("auto")}>
              {t("memory.clearAuto")}
            </button>
            <button type="button" className="pw-btn-sm" onClick={() => handleClear("all")}>
              {t("memory.clearAll")}
            </button>
          </div>
        </SRow>
      </SettingCard>
    </>
  );
}
