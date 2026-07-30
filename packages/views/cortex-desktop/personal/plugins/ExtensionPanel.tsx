// pi 扩展市场面板（U6）:已装扩展管理 + 按 ref 安装。范围仅扩展（npm/git 包）,不含远程浏览目录。
// 两道门（产品里仅有的「执行第三方代码」决策点,不可照抄无信息按钮）:
//   · 来源确认门(R5):安装前展示从 ref 解析的来源/版本 + 「将下载并执行第三方代码」告知。
//   · 信任门(R6):启用前展示落盘路径/来源/溯源 + 「启用后每轮会话执行该代码」告知。
// 装≠启用 + 惰性生效:启用只写 store,本轮不变,下一轮对话冷重开生效 → 给「下一轮生效」徽标。
// 状态:安装中(去重)、失败 inline 反馈、已失踪（pi list 不含,给「重新安装/移除记录」）、空态二分。

import { useCallback, useEffect, useMemo, useState } from "react";
import { Icon } from "@cortex-work/ui/icons";
import {
  useDesktopBridge,
  usePersonalStore,
  decorateExtensions,
  installExtension,
  uninstallExtension,
  enableExtension,
  disableExtension,
  DEFAULT_PI_EXTENSIONS,
  type InstalledExtension,
} from "@cortex-work/core";

// 只缓存 pi list 的原始路径;enabled/trusted/missing 经 useMemo 叠加 live store（与 SkillPanel 同款,
// 启停即时反映,无需重新拉取）。install/uninstall 改变存在性,才 refresh。
type LoadState =
  | { kind: "loading" }
  | { kind: "error"; error: string }
  | { kind: "ready"; paths: string[] };

// 从安装 ref 解析展示信息（安装前无 pi list,只能据 ref 字符串）。
function parseRef(raw: string): { origin: string; name: string; version: string } {
  const ref = raw.trim();
  let origin = "npm";
  if (ref.startsWith("git:") || ref.startsWith("https://") || ref.startsWith("ssh://") || ref.includes("github.com"))
    origin = "git";
  else if (ref.startsWith("./") || ref.startsWith("../") || ref.startsWith("/")) origin = "local";
  const body = ref.replace(/^npm:/, "");
  const at = body.lastIndexOf("@");
  const hash = ref.indexOf("#");
  let version = "latest / 默认分支";
  if (origin === "npm" && at > 0) version = body.slice(at + 1);
  else if (origin === "git" && hash >= 0) version = ref.slice(hash + 1);
  return { origin, name: body, version };
}

export function ExtensionPanel({ bridge }: { bridge: ReturnType<typeof useDesktopBridge> }) {
  const removeRecord = usePersonalStore((s) => s.removeInstalledExtension);
  const piExt = usePersonalStore((s) => s.generalSettings.piExtensions) ?? DEFAULT_PI_EXTENSIONS;

  const [state, setState] = useState<LoadState>({ kind: "loading" });
  const [installRef, setInstallRef] = useState("");
  const [pendingInstall, setPendingInstall] = useState<string | null>(null); // 待来源确认的 ref
  const [installing, setInstalling] = useState<Set<string>>(new Set()); // 安装中的 ref（去重）
  const [trustGate, setTrustGate] = useState<InstalledExtension | null>(null); // 待信任确认的项
  const [confirmRemove, setConfirmRemove] = useState<InstalledExtension | null>(null); // 待卸载确认的项
  const [justEnabled, setJustEnabled] = useState<Set<string>>(new Set()); // 本会话刚启用 → 下一轮生效徽标
  const [feedback, setFeedback] = useState<{ ok: boolean; text: string } | null>(null);
  const [query, setQuery] = useState("");

  const noBridge = !bridge?.piExtList;

  const refresh = useCallback(async () => {
    if (!bridge?.piExtList) {
      setState({ kind: "ready", paths: [] });
      return;
    }
    setState({ kind: "loading" });
    try {
      setState({ kind: "ready", paths: await bridge.piExtList() });
    } catch (e) {
      setState({ kind: "error", error: e instanceof Error ? e.message : String(e) });
    }
  }, [bridge]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  // 原始 pi list 路径 + live store 叠加 → 富项（启停即时反映）。
  const items = useMemo(
    () =>
      state.kind === "ready"
        ? decorateExtensions(piExt.installed, state.paths, piExt.enabled, piExt.trusted)
        : [],
    [state, piExt],
  );
  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return items;
    return items.filter((i) => i.ref.toLowerCase().includes(q) || i.sourceRef.toLowerCase().includes(q));
  }, [items, query]);

  const confirmInstall = useCallback(async () => {
    if (!pendingInstall) return;
    const ref = pendingInstall;
    setPendingInstall(null);
    setInstalling((s) => new Set(s).add(ref));
    setFeedback(null);
    try {
      const r = await installExtension(bridge!, ref);
      if (r.ok) {
        setFeedback({ ok: true, text: `已安装 ${ref}（未启用）` });
        setInstallRef("");
        await refresh();
      } else {
        setFeedback({ ok: false, text: `安装失败：${r.error}` });
      }
    } finally {
      setInstalling((s) => {
        const n = new Set(s);
        n.delete(ref);
        return n;
      });
    }
  }, [pendingInstall, bridge, refresh]);

  const confirmEnable = useCallback(() => {
    if (!trustGate) return;
    enableExtension(trustGate.scope, trustGate.ref);
    setJustEnabled((s) => new Set(s).add(`${trustGate.scope}:${trustGate.ref}`));
    setTrustGate(null);
  }, [trustGate]);

  const doUninstall = useCallback(async () => {
    if (!confirmRemove) return;
    const it = confirmRemove;
    setConfirmRemove(null);
    setFeedback(null);
    const r = await uninstallExtension(bridge!, it.scope, it.ref, it.sourceRef);
    setFeedback(r.ok ? { ok: true, text: `已卸载 ${it.ref}` } : { ok: false, text: `卸载失败：${r.error}` });
    await refresh();
  }, [confirmRemove, bridge, refresh]);

  const installingThis = pendingInstall ? installing.has(pendingInstall) : false;

  return (
    <div className="pw-plugins-skill">
      {/* 按 ref 安装。 */}
      <div className="pw-plugins-toolbar pw-plugins-toolbar-search">
        <div className="pw-search">
          <Icon.Plus size={16} />
          <input
            className="pw-input pw-search-input"
            placeholder="按 ref 安装，如 npm:@scope/pkg 或 git:github.com/u/r"
            aria-label="安装扩展 ref"
            value={installRef}
            onChange={(e) => setInstallRef(e.target.value)}
            spellCheck={false}
          />
        </div>
        <button
          type="button"
          className="pw-btn pw-btn-primary"
          disabled={noBridge || !installRef.trim() || installing.has(installRef.trim())}
          onClick={() => {
            setFeedback(null);
            setPendingInstall(installRef.trim());
          }}
        >
          {installing.has(installRef.trim()) ? "安装中…" : "安装"}
        </button>
      </div>

      {/* 来源确认门（R5）:安装前告知「将下载并执行第三方代码」。 */}
      {pendingInstall
        ? (() => {
            const p = parseRef(pendingInstall);
            return (
              <div className="pw-plugins-create">
                <div className="pw-plugins-create-row">
                  <span className="pw-plugins-stat">
                    来源 <b>{p.origin}</b> · 包 <b>{p.name}</b> · 版本 <b>{p.version}</b>
                  </span>
                </div>
                <div className="pw-plugins-err">
                  确认即从该来源下载并安装第三方扩展（其代码将在你机器上运行）。仅安装你信任的来源。
                </div>
                <div className="pw-plugins-create-foot">
                  <button type="button" className="pw-btn" onClick={() => setPendingInstall(null)}>
                    取消
                  </button>
                  <button
                    type="button"
                    className="pw-pill"
                    disabled={installingThis}
                    onClick={() => void confirmInstall()}
                  >
                    {installingThis ? "安装中…" : "确认安装"}
                  </button>
                </div>
              </div>
            );
          })()
        : null}

      {/* 搜索已装。 */}
      <div className="pw-plugins-toolbar pw-plugins-toolbar-search">
        <div className="pw-search">
          <Icon.Search size={16} />
          <input
            className="pw-input pw-search-input"
            placeholder="搜索已装扩展"
            aria-label="搜索已装扩展"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            spellCheck={false}
          />
        </div>
        <button type="button" className="pw-btn" onClick={() => void refresh()} disabled={noBridge}>
          <Icon.Retry size={14} /> 刷新
        </button>
      </div>

      {feedback ? (
        <div className={feedback.ok ? "pw-plugins-ok" : "pw-plugins-err"} role={feedback.ok ? "status" : "alert"}>
          {feedback.text}
        </div>
      ) : null}

      <div className="pw-plugins-hint">装≠启用：安装只下载入库，需「信任并启用」后于下一轮对话生效（会重开 pi 会话）。</div>

      {noBridge ? (
        <div className="pw-plugins-empty" role="status">
          当前环境不支持扩展安装（仅桌面端可用）。
        </div>
      ) : state.kind === "loading" ? (
        <div className="pw-plugins-empty" role="status">
          加载中…
        </div>
      ) : state.kind === "error" ? (
        <div className="pw-plugins-empty" role="alert">
          <div className="pw-plugins-empty-title">加载失败</div>
          <div className="pw-plugins-empty-desc">{state.error}</div>
          <button type="button" className="pw-btn" onClick={() => void refresh()}>
            重试
          </button>
        </div>
      ) : items.length === 0 ? (
        <div className="pw-plugins-empty" role="status">
          <div className="pw-plugins-empty-title">还没有已装扩展</div>
          <div className="pw-plugins-empty-desc">在上方输入 npm:包名 或 git:仓库 安装一个扩展。</div>
        </div>
      ) : filtered.length === 0 ? (
        <div className="pw-plugins-empty" role="status">
          没有匹配的扩展。
        </div>
      ) : (
        <div className="pw-plugins-grid">
          {filtered.map((it) => (
            <ExtensionCard
              key={`${it.scope}:${it.ref}`}
              ext={it}
              pendingApply={justEnabled.has(`${it.scope}:${it.ref}`) && it.enabled}
              onEnable={() => setTrustGate(it)}
              onDisable={() => disableExtension(it.scope, it.ref)}
              onUninstall={() => setConfirmRemove(it)}
              onReinstall={() => {
                setFeedback(null);
                setPendingInstall(it.sourceRef);
              }}
              onForget={() => {
                removeRecord(it.scope, it.ref);
                void refresh();
              }}
            />
          ))}
        </div>
      )}

      {/* 信任门（R6）:启用前告知「启用后每轮会话执行该代码」。 */}
      {trustGate ? (
        <div className="pw-plugins-create" role="dialog" aria-label="信任并启用扩展">
          <div className="pw-plugins-create-row">
            <span className="pw-plugins-stat">
              {trustGate.ref} · 来源 <b>{trustGate.origin}</b>
              {trustGate.path ? (
                <>
                  {" "}
                  · 落盘 <code>{trustGate.path}</code>
                </>
              ) : null}
            </span>
          </div>
          <div className="pw-plugins-err">
            启用后，该扩展的代码将在每一轮 pi 会话中执行。仅在你信任其来源时启用。
          </div>
          <div className="pw-plugins-create-foot">
            <button type="button" className="pw-btn" onClick={() => setTrustGate(null)}>
              取消
            </button>
            <button type="button" className="pw-pill" onClick={confirmEnable}>
              信任并启用
            </button>
          </div>
        </div>
      ) : null}

      {/* 卸载确认:在用扩展提示「先停用并于下一轮移除」(C2)。 */}
      {confirmRemove ? (
        <div className="pw-plugins-create" role="dialog" aria-label="卸载扩展">
          <div className="pw-plugins-err">
            卸载 {confirmRemove.ref} 不可逆（需重走安装 + 信任门才能恢复）。
            {confirmRemove.enabled ? "该扩展正在启用——将先停用，并于下一轮会话移除。" : ""}
          </div>
          <div className="pw-plugins-create-foot">
            <button type="button" className="pw-btn" onClick={() => setConfirmRemove(null)}>
              取消
            </button>
            <button type="button" className="pw-pill" onClick={() => void doUninstall()}>
              确认卸载
            </button>
          </div>
        </div>
      ) : null}
    </div>
  );
}

function ExtensionCard({
  ext,
  pendingApply,
  onEnable,
  onDisable,
  onUninstall,
  onReinstall,
  onForget,
}: {
  ext: InstalledExtension;
  pendingApply: boolean;
  onEnable: () => void;
  onDisable: () => void;
  onUninstall: () => void;
  onReinstall: () => void;
  onForget: () => void;
}) {
  return (
    <div className={`pw-plugins-card ${ext.missing ? "is-shadowed" : ""}`}>
      {/* 状态点:绿=启用(代码在跑) / 灰=已装未启用 / 琥珀=失踪。运行态一眼可辨。 */}
      <span
        className="pw-plugins-dot"
        data-state={ext.missing ? "missing" : ext.enabled ? "on" : "off"}
        aria-hidden
      />
      <div className="pw-plugins-card-main">
        <div className="pw-plugins-card-title">
          <span className="pw-plugins-card-name">{ext.ref}</span>
          <span className="pw-tag pw-tag--origin">{ext.origin}</span>
          {ext.enabled ? (
            <span className="pw-tag pw-tag--on">已启用</span>
          ) : (
            <span className="pw-tag pw-tag--off">已安装·未启用</span>
          )}
          {pendingApply ? <span className="pw-tag pw-tag--pending">下一轮对话生效</span> : null}
          {ext.missing ? <span className="pw-tag pw-tag--warn">已失踪</span> : null}
        </div>
        <div className="pw-plugins-card-desc">
          {ext.version ? `版本 ${ext.version} · ` : ""}
          {ext.missing ? (
            "pi list 中已找不到该扩展（外部删除/损坏）。"
          ) : (
            <span className="pw-plugins-card-path" title={ext.path}>
              {ext.path}
            </span>
          )}
        </div>
      </div>
      {ext.missing ? (
        <div className="pw-plugins-card-actions">
          <button type="button" className="pw-pill" onClick={onReinstall}>
            重新安装
          </button>
          <button type="button" className="pw-btn-sm" onClick={onForget}>
            移除记录
          </button>
        </div>
      ) : (
        <div className="pw-plugins-card-actions">
          {ext.enabled ? (
            // 「禁用」关停在跑扩展,中性样式 + hover 染红(破坏性动作不喧哗)。
            <button type="button" className="pw-pill pw-pill--muted" onClick={onDisable}>
              禁用
            </button>
          ) : (
            // 「信任并启用」是引导的下一步,用品牌紫胶囊吸引视线。
            <button type="button" className="pw-pill" onClick={onEnable}>
              信任并启用
            </button>
          )}
          <button type="button" className="pw-btn-sm pw-btn-sm--danger" onClick={onUninstall}>
            卸载
          </button>
        </div>
      )}
    </div>
  );
}
