// Composer 上方的「目录授权」pill(与 mode 正交)。多选授权类 + 自定义目录管理。
// 关键交互(见计划 U6):
//  - 折叠标签:首个授权短名 + 多于一个时「 +N」。
//  - all-files 仅 mode=full-auto 可勾,否则置灰;首次启用弹一次确认;激活常驻警示。
//    mode 切走 full-auto 时 all-files 保留勾选但置灰(期望态记录,KTD4),不静默删除。
//  - 自定义目录:经原生目录选择器添加;chip 可删;落在 workspace 内给去重提示;上限 5。
//  - pi:custom/generated-images 显示降级 ⚠(pi 无可写额外目录,仅 app 侧可读/打开)。
//  - running 时整体禁用(改授权不影响已 spawn 的本轮)。

import { useState } from "react";
import { Icon } from "@cortex-work/ui/icons";
import {
  DIRECTORY_GRANT_KINDS,
  useDesktopBridge,
  type AgentKind,
  type DirectoryGrant,
  type DirectoryGrantKind,
  type PermissionMode,
} from "@cortex-work/core";
import { useTranslation } from "@cortex-work/core/i18n";

const MAX_CUSTOM_DIRS = 5;

function hasKind(grants: DirectoryGrant[], kind: DirectoryGrantKind): boolean {
  return grants.some((g) => g.kind === kind);
}
function customGrant(grants: DirectoryGrant[]): Extract<DirectoryGrant, { kind: "custom" }> | undefined {
  return grants.find((g): g is Extract<DirectoryGrant, { kind: "custom" }> => g.kind === "custom");
}

export function DirectoryGrantPill({
  grants,
  onChange,
  permissionMode,
  running,
  agent,
  onToast,
}: {
  grants: DirectoryGrant[];
  onChange: (grants: DirectoryGrant[]) => void;
  permissionMode?: PermissionMode;
  running: boolean;
  agent: AgentKind;
  onToast: (text: string) => void;
}) {
  const { t } = useTranslation("chat");
  const bridge = useDesktopBridge();
  const [open, setOpen] = useState(false);

  const isFullAuto = permissionMode === "full-auto";
  const custom = customGrant(grants);

  // 折叠标签:首个授权名 + 「 +N」。
  const first = grants[0];
  const label = !first
    ? t("composer.directoryGrant.workspace")
    : t(`composer.directoryGrant.${first.kind}`) + (grants.length > 1 ? ` +${grants.length - 1}` : "");

  // 勾选/取消某授权类。all-files 首次勾选需确认(KTD4);取消即移除。
  const toggleKind = (kind: DirectoryGrantKind) => {
    const on = hasKind(grants, kind);
    if (on) {
      onChange(grants.filter((g) => g.kind !== kind));
      return;
    }
    if (kind === "all-files") {
      if (!isFullAuto) return; // 非 full-auto 不可勾(UI 已置灰,双保险)。
      const ok =
        typeof window !== "undefined" && typeof window.confirm === "function"
          ? window.confirm(t("composer.directoryGrant.allFilesConfirm"))
          : true;
      if (!ok) return;
    }
    // custom 勾选 = 加一个空 custom(待用户添加目录);其余加无参 grant。
    const added: DirectoryGrant = kind === "custom" ? { kind: "custom", dirs: [] } : { kind };
    onChange([...grants, added]);
  };

  // 经原生目录选择器添加自定义目录。
  const addDir = async () => {
    if (!bridge?.pickDirectory) return;
    const dir = await bridge.pickDirectory();
    if (!dir) return;
    const cur = custom?.dirs ?? [];
    if (cur.includes(dir)) return;
    if (cur.length >= MAX_CUSTOM_DIRS) {
      onToast(t("composer.directoryGrant.maxDirs", { n: MAX_CUSTOM_DIRS }));
      return;
    }
    // 注:与 workspace 根的去重在主进程 allowedRoots 合并时自然生效(isInside),此处不重复判定
    //(渲染端不持有 workspace 绝对根路径)。
    const next = grants.some((g) => g.kind === "custom")
      ? grants.map((g) => (g.kind === "custom" ? { kind: "custom" as const, dirs: [...g.dirs, dir] } : g))
      : [...grants, { kind: "custom" as const, dirs: [dir] }];
    onChange(next);
  };

  const removeDir = (dir: string) => {
    // custom 清空后保留空条目(用户仍勾着 custom);如需彻底移除走取消勾选。
    onChange(
      grants.map((g) =>
        g.kind === "custom" ? { kind: "custom" as const, dirs: g.dirs.filter((d) => d !== dir) } : g,
      ),
    );
  };

  // pi 对额外目录的写授权降级:custom/generated-images 标 ⚠。
  const showDowngrade = (kind: DirectoryGrantKind) =>
    agent === "pi" && (kind === "custom" || kind === "generated-images");

  return (
    <span className="pw-grant-pill">
      <button
        type="button"
        className="pw-grant-trigger is-clickable"
        data-open={open}
        data-warn={hasKind(grants, "all-files") ? "1" : undefined}
        onClick={() => setOpen((v) => !v)}
        disabled={running}
        aria-haspopup="menu"
        aria-expanded={open}
        title={t("composer.directoryGrant.label")}
      >
        <Icon.Folder size={12} />
        {label}
        <Icon.Chevron size={11} className="chev" />
      </button>
      {open ? (
        <>
          <div className="pw-grant-backdrop" onClick={() => setOpen(false)} />
          <div className="pw-grant-panel" role="menu">
            {DIRECTORY_GRANT_KINDS.map((kind) => {
              const checked = hasKind(grants, kind);
              const disabled = kind === "all-files" && !isFullAuto && !checked;
              return (
                <div key={kind} className="pw-grant-row">
                  <label
                    className="pw-grant-opt"
                    data-disabled={disabled ? "1" : undefined}
                    title={
                      disabled
                        ? t("composer.directoryGrant.allFilesDisabled")
                        : t(
                            `composer.directoryGrant.${kind === "generated-images" ? "generatedImagesHint" : kind === "all-files" ? "allFilesHint" : kind + "Hint"}`,
                          )
                    }
                  >
                    <input
                      type="checkbox"
                      checked={checked}
                      disabled={disabled}
                      onChange={() => toggleKind(kind)}
                    />
                    {t(`composer.directoryGrant.${kind}`)}
                    {showDowngrade(kind) ? (
                      <span className="pw-grant-warn" title={t("composer.directoryGrant.downgradePi")}>
                        ⚠
                      </span>
                    ) : null}
                  </label>
                  {/* custom 行:展开已选目录 chip + 添加按钮 */}
                  {kind === "custom" && checked ? (
                    <div className="pw-grant-dirs">
                      {(custom?.dirs ?? []).map((d) => (
                        <span key={d} className="pw-grant-chip" title={d}>
                          {d.split("/").pop() || d}
                          <button type="button" className="pw-grant-chip-x" onClick={() => removeDir(d)}>
                            ×
                          </button>
                        </span>
                      ))}
                      <button type="button" className="pw-grant-add" onClick={addDir}>
                        {t("composer.directoryGrant.addDir")}
                      </button>
                    </div>
                  ) : null}
                </div>
              );
            })}
          </div>
        </>
      ) : null}
    </span>
  );
}
