// 公司知识库设置分区。
//
// 三处刻意的设计，改动前请先读完：
//   1. **令牌明文只单向流向 main**：输入框永远从空开始，落盘的是 safeStorage 密文，
//      UI 连密文都不展示，只显示「已配置 / 未配置」。渲染进程不持久化明文，也不向 main 反向索取。
//      （同 ResearchSettingsSection 的 PAT 处理）
//   2. **保存走 bridge 的窄写 channel，不走 setGeneral 全量写回**：encryptedToken 是主进程写的，
//      renderer 那份快照里没有它，全量写回会把刚存的密文抹掉（clobber）。
//      故本分区的 enabled / baseUrl 也一并交给同一个 channel 保存，避免两条写路径打架。
//   3. **权限边界不在这里**：能不能写入知识库由服务端令牌的 scope 决定，客户端不放「允许写入」
//      开关——那种开关会让人误以为关掉它就安全，实际上它只是个提示。
//      令牌 scope 是唯一真源，所以这里改为把「当前令牌能用哪些工具」如实显示出来。
//
// 文案硬编码 zh-Hans（个人工作区惯例，不走 t()）。
import { useCallback, useEffect, useState, type ReactElement } from "react";
import { usePersonalStore, useDesktopBridge } from "@cortex-work/core";
import { SettingCard, SRow, SwitchRow } from "./settingsControls";

/// 写入工具名。用于把自检结果翻译成「这枚令牌能不能写」这句人话。
const WRITE_TOOL = "kb_write_doc";

export function KnowledgeSettingsSection(): ReactElement {
  const bridge = useDesktopBridge();
  const general = usePersonalStore((s) => s.generalSettings);
  const setGeneral = usePersonalStore((s) => s.setGeneralSettings);
  const kb = general?.knowledgeBase;

  const [baseUrl, setBaseUrl] = useState(kb?.baseUrl ?? "");
  const [token, setToken] = useState("");
  const [busy, setBusy] = useState(false);
  const [probe, setProbe] = useState<{ ok: boolean; message: string; tools?: string[] } | null>(null);

  // 外部（如另一个窗口）改动配置时同步输入框，但**不碰 token**——它永远从空开始。
  useEffect(() => setBaseUrl(kb?.baseUrl ?? ""), [kb?.baseUrl]);

  const enabled = kb?.enabled ?? false;
  const hasToken = kb?.hasToken ?? Boolean(kb?.encryptedToken);
  // 能力缺失时（Web 端 / 旧壳）禁用并说明原因，而不是点了静默无事。
  const canEdit = Boolean(bridge?.knowledge);
  // 有未保存的修改。**测试连接必须先保存**：自检读的是磁盘上已加密的令牌，
  // 输入框里刚敲的内容它看不到——不拦住的话，用户会看到「填了令牌却说没填」这种莫名其妙的结果。
  const dirty = token.trim().length > 0 || baseUrl.trim() !== (kb?.baseUrl ?? "").trim();

  /// 保存配置。enabled / baseUrl / token 一起提交，由主进程加密并窄写落盘。
  const save = useCallback(
    async (nextEnabled: boolean) => {
      if (!bridge?.knowledge) return;
      setBusy(true);
      setProbe(null);
      try {
        const saved = await bridge.knowledge.setCredential({
          enabled: nextEnabled,
          baseUrl: baseUrl.trim(),
          token: token.trim() || undefined,
        });
        // 用主进程回传的切片更新 store：它带着落盘后的 hasToken，
        // renderer 自己拼一个会和磁盘状态漂移。
        setGeneral({ knowledgeBase: saved });
        setToken(""); // 存完立刻清空明文，不在内存里多留一秒
      } catch (e) {
        setProbe({ ok: false, message: e instanceof Error ? e.message : String(e) });
      } finally {
        setBusy(false);
      }
    },
    [bridge, baseUrl, token, setGeneral],
  );

  const clearToken = useCallback(async () => {
    if (!bridge?.knowledge) return;
    setBusy(true);
    try {
      setGeneral({ knowledgeBase: await bridge.knowledge.clearCredential() });
      setProbe(null);
    } finally {
      setBusy(false);
    }
  }, [bridge, setGeneral]);

  const test = useCallback(async () => {
    if (!bridge?.knowledge) return;
    setBusy(true);
    try {
      setProbe(await bridge.knowledge.test());
    } catch (e) {
      setProbe({ ok: false, message: e instanceof Error ? e.message : String(e) });
    } finally {
      setBusy(false);
    }
  }, [bridge]);

  // 自检回来的工具清单直接反映令牌 scope：没有 kb_write_doc 就是只读令牌。
  // 这比放一个客户端「允许写入」开关诚实得多。
  const scopeHint = probe?.tools?.length
    ? probe.tools.includes(WRITE_TOOL)
      ? "当前令牌可检索、也可写入沉淀。"
      : "当前令牌为只读：可检索与问答，不能写入。"
    : null;

  return (
    <SettingCard title="公司知识库">
      <SwitchRow
        label="启用知识库"
        desc="开启后，会话中的 Agent 可以自主检索公司内部文档作为依据。"
        value={enabled}
        onChange={(v) => void save(v)}
      />
      <div className="pw-srow-desc">
        知识库以 MCP 方式接入，Claude Code / Codex / Cortex 三端通用。地址与令牌向管理员索取；
        令牌加密保存在本机，界面不会回显。
      </div>

      <label className="pw-set-field">
        <span className="pw-set-lbl">知识库地址</span>
        <input
          className="pw-set-input"
          value={baseUrl}
          placeholder="http://kb.internal:8501"
          spellCheck={false}
          disabled={!canEdit}
          onChange={(e) => setBaseUrl(e.target.value)}
        />
      </label>

      {/* 令牌：password 输入，永远从空开始；已保存的令牌只以「已配置」呈现。 */}
      <label className="pw-set-field">
        <span className="pw-set-lbl">MCP 令牌</span>
        <input
          className="pw-set-input"
          type="password"
          value={token}
          placeholder={hasToken ? "如需更换请输入新令牌" : "粘贴 MCP 令牌"}
          spellCheck={false}
          autoComplete="off"
          disabled={!canEdit}
          onChange={(e) => setToken(e.target.value)}
        />
      </label>

      <SRow label="令牌状态" desc="令牌加密保存在本机，界面不会回显。" end>
        <span className="pw-srow-desc">{hasToken ? "已配置" : "未配置"}</span>
      </SRow>

      <div className="pw-srow">
        <div className="pw-srow-l">
          {!canEdit ? (
            <span className="pw-srow-desc">当前版本尚不支持在此配置知识库。</span>
          ) : dirty ? (
            <span className="pw-srow-desc">有未保存的修改，请先点「保存」再测试连接。</span>
          ) : null}
          {probe ? (
            <span className="pw-srow-desc">
              {probe.ok ? "✓ " : "✗ "}
              {probe.message}
              {scopeHint ? ` ${scopeHint}` : ""}
            </span>
          ) : null}
        </div>
        <div className="pw-srow-c pw-srow-c-end">
          <button
            type="button"
            className="pw-btn-sm"
            disabled={!canEdit || busy || !baseUrl.trim()}
            onClick={() => void save(enabled)}
          >
            保存
          </button>
          <button
            type="button"
            className="pw-btn-sm"
            disabled={!canEdit || busy || !hasToken || dirty}
            onClick={() => void test()}
          >
            测试连接
          </button>
          <button
            type="button"
            className="pw-btn-sm"
            disabled={!canEdit || busy || !hasToken}
            onClick={() => void clearToken()}
          >
            移除令牌
          </button>
        </div>
      </div>
    </SettingCard>
  );
}
