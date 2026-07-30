// Computer Use（pi 操作真实桌面 GUI）配置卡片。
//
// **挂载位置**：管理页 → MCP 标签，与 ExtensionPanel（pi 原生扩展）并列（见 PluginManagePage.tsx）。
// 放这里而不是「设置 → Pi」，是因为这项能力由第三方 pi package 供能、只在 pi 会话生效，
// 与 pi 扩展同属一类。**刻意只挂一处**：同一个 store 字段若在两个设置界面各有一个开关，
// 用户无从判断哪个作准。卡片内自带「独属 pi」标记。
//
// macOS-only：非 mac 或桥缺失（Web 端）整段隐藏（返回 null，故「独属 pi」标记必须在卡片内部，
// 不能并进 PluginManagePage 那条共用提示——否则非 mac 上会留下一句指向不存在区块的说明）。
//
// 这个分区的信息设计有三件事必须讲清楚，否则用户无法自己排障：
//   1. **当前到底能不能用**。五门控（平台/开关/已装/swiftc/两项授权）里任何一条不满足都不会给
//      Agent 工具，而失败原因用户在会话里是看不见的（主进程静默不注入）。所以状态行是必需的，
//      不是装饰——没有它，用户只会觉得「说有电脑操作功能，但它从来不动」。
//   2. **定位模型这个坑**。带 target 的工具要视觉模型定位，会话模型不支持图片输入时会直接抛错。
//   3. **/learn 会录全局输入**。它是 package 自带的斜杠命令，绕过工具审批与只读白名单（那两者
//      只管 tool，管不到 command），必须如实告知。

import { useCallback, useEffect, useState } from "react";
import { useDesktopBridge, usePersonalStore } from "@cortex-work/core";
import { useTranslation } from "@cortex-work/core/i18n";
import type { ComputerUsePermissionKind, ComputerUseStatus } from "@cortex-work/core/desktop/types";

import { BareSelect, SettingCard, SRow, SwitchRow } from "./settingsControls";
import { detectIsMac } from "./platform";

// 状态行的视觉档:ok=可用、warn=缺授权/缺依赖(可自助解决)、off=用户主动关闭。
type Tone = "ok" | "warn" | "off";

const TONE_COLOR: Record<Tone, string> = {
  ok: "var(--pw-ok, #2e7d32)",
  warn: "var(--pw-warn, #b26a00)",
  off: "var(--pw-muted, #888)",
};

// 整行说明文字（无控件的告知行）。复用设置页既有的 .pw-srow / .pw-srow-desc,
// 不引入新 class:新样式要落进 cortex-desktop.css 才生效,为两行提示不值当。
function NoticeRow({ text }: { text: string }) {
  return (
    <div className="pw-srow">
      <div className="pw-srow-l">
        <span className="pw-srow-desc">{text}</span>
      </div>
    </div>
  );
}

export function ComputerUseSection() {
  const { t } = useTranslation("settings");
  const bridge = useDesktopBridge();
  const general = usePersonalStore((s) => s.generalSettings);
  const setGeneral = usePersonalStore((s) => s.setGeneralSettings);
  const providerSettings = usePersonalStore((s) => s.providerSettings);

  const [status, setStatus] = useState<ComputerUseStatus | null>(null);
  const [busy, setBusy] = useState(false);
  // 待确认的授权重申请。非 null 时展开确认卡（同 ExtensionPanel 两道门的做法）——
  // reset 会清掉本应用该项已有的授权记录,且可能导致应用被系统重启,不该点一下就跑。
  const [pendingGrant, setPendingGrant] = useState<ComputerUsePermissionKind | null>(null);
  // 操作失败提示。授权/安装是「点了会有系统级动作」的按钮,一旦 IPC 失败必须让用户看见——
  // 否则表现为「点了没反应」,而那正是这个功能最难自查的一类问题。
  const [actionError, setActionError] = useState<string | null>(null);

  // 缺省视为启用——与主进程 inject.ts、core permissionMode 的取值口径一致（三处必须同口径,
  // 否则会出现「UI 显示关、实际注入了」这类错位）。
  const enabled = general.computerUse?.enabled !== false;

  const refresh = useCallback(async () => {
    if (!bridge?.computerUse) return;
    try {
      setStatus(await bridge.computerUse.status());
    } catch {
      setStatus(null);
    }
  }, [bridge]);

  // 开关切换后要重查:关掉后 reason 会变成 disabled,状态行得跟上。
  useEffect(() => {
    void refresh();
  }, [refresh, enabled]);

  // 窗口重新获得焦点时重查。
  //
  // 这是「去授权」闭环的必要一环:授权动作发生在**系统设置**里,应用这边收不到任何通知。
  // 没有它,用户勾完权限切回来会看到状态行还停在「未授权」,只能靠切开关或重开页面来刷新——
  // 看起来就像授权没生效。
  useEffect(() => {
    const onFocus = () => void refresh();
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, [refresh]);

  // 「重新申请授权」:清掉 TCC 的「已提示过」记录 → 重新弹系统提示 → 打开设置面板。
  //
  // 为什么不是简单地「打开设置面板」:macOS 每个应用只弹一次授权提示,用户忽略后本应用就
  // 再也不会自动出现在列表里——只开面板会看到空列表,唯一出路是自己去 Finder 里翻出 .app
  // 拖进去（dev 下那个 .app 还埋在 node_modules/.pnpm 里,Finder 默认不显示点开头目录）。
  // reset 后重新弹提示,用户点一下条目就自动出现,全程不必知道 .app 在哪。
  const reprompt = useCallback(
    async (kind: ComputerUsePermissionKind) => {
      setActionError(null);
      setBusy(true);
      try {
        setStatus(await bridge!.computerUse!.repromptPermission(kind));
      } catch {
        setActionError(t("computerUse.grantFailed"));
      } finally {
        setBusy(false);
        setPendingGrant(null);
      }
    },
    [bridge, t],
  );

  // Finder 兜底:reset 仍不奏效时,直接在 Finder 里选中当前运行的 .app,拖进授权列表即可。
  const revealApp = useCallback(async () => {
    setActionError(null);
    try {
      await bridge!.computerUse!.revealApp();
    } catch {
      setActionError(t("computerUse.revealFailed"));
    }
  }, [bridge, t]);

  // 非 mac / 无桥（Web 端）整段隐藏——同 ReplySettingsSection 的降级约定。
  if (!detectIsMac() || !bridge?.computerUse) return null;

  // 「GUI 定位模型」候选:只列**已启用 provider 里勾了「支持图片输入」的模型**。
  //
  // 两条约束叠加的结果:
  //   · vision 必须为 true —— pi 侧模型注册表据此声明 input:["text","image"]（见 main/agents/
  //     pi-providers.ts renderPiExtension）,pi-computer-use 会校验它,不支持图片就直接抛错;
  //   · 只能是**当前会话 provider** 的模型 —— pi 只注册了会话选中的那一个 provider,别的
  //     provider 的模型压根不在 pi 的 modelRegistry 里。这里无法预知用户下次开会话选哪个
  //     provider,故列出所有启用 provider 的视觉模型,并在说明里点明这条限制。
  const visionModels = providerSettings.providers
    .filter((p) => p.enabled)
    .flatMap((p) => p.models.filter((m) => m.vision).map((m) => ({ value: m.id, label: `${p.name} / ${m.label ?? m.id}` })));

  // 状态行文案与视觉档:reason 与 core 的 ComputerUseBlockReason 一一对应。
  const { tone, text } = describeStatus(status, t);

  // 当前缺的是哪项授权（两项各自独立,同一时刻只会报一个——inject 门控是短路顺序）。
  const grantKind: ComputerUsePermissionKind | null =
    status?.reason === "no-accessibility"
      ? "accessibility"
      : status?.reason === "no-screen-recording"
        ? "screenRecording"
        : null;

  return (
    <SettingCard title={t("computerUse.card")}>
      {/* 「独属 pi」标记放在卡片**内部**,而不是并到外面那条覆盖 ExtensionPanel 的共用提示:
          本组件在非 mac / Web 端整段返回 null,写在外面会留下一句指向不存在区块的说明。 */}
      <div className="pw-plugins-hint pw-plugins-scope-note" role="note">
        {t("computerUse.piOnly")}
      </div>
      <SwitchRow
        label={t("computerUse.enabled")}
        desc={t("computerUse.enabledDesc")}
        value={enabled}
        onChange={(v) => setGeneral({ computerUse: { ...general.computerUse, enabled: v } })}
      />

      <SRow label={t("computerUse.status")} desc={t("computerUse.statusDesc")}>
        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
          <span style={{ color: TONE_COLOR[tone] }}>{text}</span>
          {/* 缺授权 → 一键重新申请（先确认）。kind 由 reason 直接派生,两项各自独立授权。 */}
          {grantKind ? (
            <button className="pw-btn-sm" disabled={busy} onClick={() => setPendingGrant(grantKind)}>
              {t("computerUse.grant")}
            </button>
          ) : null}
          {/* 未装好 → 手动重试（首启预装可能因离线失败）。主进程侧自带在途去重,连点安全。 */}
          {status?.reason === "not-installed" ? (
            <button
              className="pw-btn-sm"
              disabled={busy}
              onClick={async () => {
                setBusy(true);
                setActionError(null);
                try {
                  setStatus(await bridge.computerUse!.install());
                } catch {
                  setActionError(t("computerUse.installFailed"));
                } finally {
                  setBusy(false);
                }
              }}
            >
              {busy ? t("computerUse.installing") : t("computerUse.retryInstall")}
            </button>
          ) : null}
        </div>
      </SRow>

      {/* 操作失败必须可见（见 actionError 声明处的理由）。 */}
      {actionError ? <NoticeRow text={actionError} /> : null}

      {/* 重新申请授权的确认卡（同 ExtensionPanel 两道门的形态）:reset 会清掉本应用该项已有的
          授权记录,且系统可能因此重启本应用,必须让用户知情后再跑。 */}
      {pendingGrant ? (
        <div className="pw-plugins-create">
          <div className="pw-plugins-err">{t("computerUse.grantConfirmDesc")}</div>
          <div className="pw-plugins-create-foot">
            <button type="button" className="pw-btn" onClick={() => setPendingGrant(null)}>
              {t("computerUse.cancel")}
            </button>
            <button type="button" className="pw-btn-sm" disabled={busy} onClick={() => void reprompt(pendingGrant)}>
              {busy ? t("computerUse.granting") : t("computerUse.grantConfirm")}
            </button>
          </div>
        </div>
      ) : null}

      {/* 缺授权时的兜底路径:reset + 重新提示仍不奏效（系统状态各异）时,直接在 Finder 里
          选中当前运行的 .app 拖进列表。这也顺带绕开了「dev 的 Electron.app 埋在 .pnpm 隐藏
          目录里、Finder 默认看不见」这个坑——用户永远不需要知道那条路径。 */}
      {grantKind ? (
        <div className="pw-srow">
          <div className="pw-srow-l">
            <span className="pw-srow-desc">{t("computerUse.grantHint")}</span>
          </div>
          <div className="pw-srow-c pw-srow-c-end">
            <button className="pw-btn-sm" onClick={() => void revealApp()}>
              {t("computerUse.revealApp")}
            </button>
          </div>
        </div>
      ) : null}

      {enabled ? (
        <>
          <SRow label={t("computerUse.groundingModel")} desc={t("computerUse.groundingModelDesc")}>
            <BareSelect
              value={general.computerUse?.groundingModel ?? ""}
              options={[{ label: t("computerUse.groundingFollowSession"), value: "" }, ...visionModels]}
              onChange={(v) => setGeneral({ computerUse: { ...general.computerUse, groundingModel: v || undefined } })}
            />
          </SRow>
          {/* 没有任何视觉模型可选时明确点出去哪配:否则用户只看到一个只有「跟随会话模型」的下拉,
              而跟随会话模型在模型不支持图片时恰好是会抛错的那种情况。 */}
          {visionModels.length === 0 ? <NoticeRow text={t("computerUse.noVisionModel")} /> : null}
          {/* /learn 告知:它是 package 自带斜杠命令,绕过工具审批与只读白名单（二者只管 tool）。 */}
          <NoticeRow text={t("computerUse.learnNotice")} />
        </>
      ) : null}
    </SettingCard>
  );
}

// 把状态映射成一句人话 + 视觉档。抽成纯函数便于单测,也避免 JSX 里堆三元。
export function describeStatus(
  status: ComputerUseStatus | null,
  t: (key: string) => string,
): { tone: Tone; text: string } {
  if (!status) return { tone: "warn", text: t("computerUse.stateUnknown") };
  if (status.ready) return { tone: "ok", text: t("computerUse.stateReady") };
  switch (status.reason) {
    case "disabled":
      return { tone: "off", text: t("computerUse.stateDisabled") };
    case "not-installed":
      return { tone: "warn", text: t("computerUse.stateNotInstalled") };
    case "no-swiftc":
      return { tone: "warn", text: t("computerUse.stateNoSwiftc") };
    case "no-accessibility":
      return { tone: "warn", text: t("computerUse.stateNoAccessibility") };
    case "no-screen-recording":
      return { tone: "warn", text: t("computerUse.stateNoScreenRecording") };
    case "not-macos":
      return { tone: "off", text: t("computerUse.stateNotMacos") };
    default:
      return { tone: "warn", text: t("computerUse.stateUnknown") };
  }
}
