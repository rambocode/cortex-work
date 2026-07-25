// 研究引擎（Cortex Research Engine）设置分区（P8 接线）。
//
// 三处刻意的设计，改动前请先读完：
//   1. **未实现的 consumer 开关一律禁用**并标「即将支持」。M1 只有 chat 与 deep_research 真正接入
//      （见 core/research/consumer.ts 头注与 main 的 research-service.ts 开关映射表），
//      给用户一个写得进配置、后端却不读的开关，比不给还糟。
//   2. **PAT 明文只单向流向 main**：输入框永远从空开始，落盘的是 safeStorage 密文，UI 连密文都不展示，
//      只显示「已配置 / 未配置」。渲染进程不持久化明文，也不向 main 反向索取（spec §16）。
//   3. **写回时保留 raw.searchServer**：encryptedToken 是主进程写的，归一化在 baseUrl/workspaceId
//      不全时会整段丢弃 searchServer，若拿归一化结果直接回写就会把密文抹掉（clobber）。
//
// 文案硬编码 zh-Hans（个人工作区惯例，不走 t()）；「用哪个模型 + 数据会去哪」经
// resolveResearchModelDisplay 解析，与新建表单、主进程编排层同走 core 的 selectResearchModel，
// 设置页不另写一套规则，避免「设置里显示 A、实际跑 B」。
import { useCallback, useMemo, useState, type ReactElement } from "react";
import { usePersonalStore, useDesktopBridge } from "@cortex-work/core";
import {
  normalizeResearchEngineSettings,
  type ResearchEngineSettings,
} from "@cortex-work/core/research/settings";
import { resolveResearchModelDisplay } from "../research/modelDisplay";
import "../research/research.css";
import { SettingCard, SRow } from "./settingsControls";

/// 可禁用的开关行。settingsControls 的 SwitchRow 不支持禁用与角标，此处就近扩一个本地版本，
/// 不动共享控件（改共享控件会波及十余个设置分区）。
function FlagRow({
  label,
  desc,
  value,
  onChange,
  disabled,
  badge,
}: {
  label: string;
  desc?: string;
  value: boolean;
  onChange: (v: boolean) => void;
  disabled?: boolean;
  badge?: string;
}): ReactElement {
  return (
    <SRow label={label} desc={desc} end>
      {badge ? <span className="pw-srow-desc">{badge}</span> : null}
      <button
        type="button"
        className="twk-toggle"
        data-on={value ? "1" : "0"}
        role="switch"
        aria-checked={value}
        aria-label={label}
        disabled={disabled}
        onClick={() => onChange(!value)}
      >
        <i />
      </button>
    </SRow>
  );
}

/// M1 尚未落地的 consumer 开关清单（UI 禁用 + 标注）。
/// 与 main 的 CONSUMER_FLAG 映射表配套：那边有键位，这边有开关，但适配器还没写。
const COMING_SOON_BADGE = "即将支持";

export function ResearchSettingsSection(): ReactElement {
  const bridge = useDesktopBridge();
  // raw 是磁盘/主进程写入的原始切片；normalize 只用于「读」出稳妥的展示值，
  // 写回时必须带上 raw.searchServer（见文件头第 3 条）。
  const raw = usePersonalStore((s) => s.generalSettings.researchEngine);
  const setGeneralSettings = usePersonalStore((s) => s.setGeneralSettings);
  const settings = useMemo(() => normalizeResearchEngineSettings(raw), [raw]);
  // 全局供应商配置：模型下拉的选项来源，同时提供「跟随全局默认」这一档的实际取值。
  const providerSettings = usePersonalStore((s) => s.providerSettings);

  // 实际生效的研究模型。**显示这个而不是显示用户填的字面值**：偏好指向的供应商被删掉时，
  // core 会静默降级到全局默认，界面必须站在实际那一侧，否则用户以为在用 A、其实跑的是 B。
  const model = useMemo(
    () =>
      resolveResearchModelDisplay(providerSettings, {
        ...(settings.modelProviderId ? { providerId: settings.modelProviderId } : {}),
        ...(settings.modelId ? { modelId: settings.modelId } : {}),
      }),
    [providerSettings, settings.modelProviderId, settings.modelId],
  );
  // 模型下拉只列**生效供应商**名下的模型：列出别家的模型，用户选了也会被选型丢弃。
  const modelOptions =
    providerSettings.providers.find((p) => p.id === model.providerId)?.models ?? [];

  // Search Server 的 baseUrl / workspaceId 用本地草稿驱动显示：归一化在两者不全时会整段丢弃
  // searchServer，若直接以归一化结果回填输入框，用户「先填地址后填工作区」的中间态会被清空。
  const [server, setServer] = useState(() => ({
    baseUrl: raw?.searchServer?.baseUrl ?? "",
    workspaceId: raw?.searchServer?.workspaceId ?? "",
  }));
  // 明文 PAT：只存在于这个 state 里，提交后立即清空，不写 store、不落盘。
  const [token, setToken] = useState("");
  // 保存/测试的结果提示（一句人话，来自 main 的探测结果或本地异常）。
  const [probeText, setProbeText] = useState<string | null>(null);

  const hasToken = !!raw?.searchServer?.encryptedToken;
  const researchBridge = bridge?.research;
  const canSaveCredential = typeof researchBridge?.setSearchServerCredential === "function";
  const canTestServer = typeof researchBridge?.testSearchServer === "function";

  /// 局部更新 researchEngine 切片。基线取归一化结果 + 原始 searchServer，
  /// 保证渲染端的任何一次写入都不会抹掉主进程加密落盘的 PAT。
  const patch = useCallback(
    (next: Partial<ResearchEngineSettings>) => {
      const base: ResearchEngineSettings = raw?.searchServer
        ? { ...settings, searchServer: raw.searchServer }
        : settings;
      setGeneralSettings({ researchEngine: { ...base, ...next } });
    },
    [raw, settings, setGeneralSettings],
  );

  /// 更新 Search Server 的非机密字段（地址 / 工作区）：本地草稿与 store 同步写。
  const patchServer = useCallback(
    (next: Partial<{ baseUrl: string; workspaceId: string }>) => {
      const merged = { ...server, ...next };
      setServer(merged);
      patch({
        searchServer: {
          ...raw?.searchServer,
          baseUrl: merged.baseUrl,
          workspaceId: merged.workspaceId,
        },
      });
    },
    [server, raw, patch],
  );

  /// 提交明文 PAT：单向传给 main 加密落盘，成功与否都立刻清空输入框。
  ///
  /// **必须把 main 回传的密文写回 store**：本组件的全量写回以 raw.searchServer 为基线，
  /// 而 renderer 这边并不知道 main 刚写了 encryptedToken；不回写的话，用户随后动任何一个
  /// 开关都会用这份缺密文的副本覆盖磁盘，把刚保存的 PAT 抹掉（回归测试守着这条）。
  const saveToken = useCallback(() => {
    const fn = researchBridge?.setSearchServerCredential;
    if (!fn) return;
    const plain = token;
    setToken("");
    void fn({ baseUrl: server.baseUrl.trim(), workspaceId: server.workspaceId.trim(), token: plain })
      .then((saved) => {
        if (saved) patch({ searchServer: saved });
        setProbeText("令牌已保存（已加密存储）");
      })
      .catch((e: unknown) => setProbeText(`保存失败：${e instanceof Error ? e.message : String(e)}`));
  }, [researchBridge, token, server, patch]);

  /// 连通性探测：**不传也不回传任何凭据**，main 用已保存的密文自行解密发起。
  const testServer = useCallback(() => {
    const fn = researchBridge?.testSearchServer;
    if (!fn) return;
    setProbeText("正在测试连接…");
    void fn()
      .then((r) => setProbeText(r.message))
      .catch((e: unknown) => setProbeText(`测试失败：${e instanceof Error ? e.message : String(e)}`));
  }, [researchBridge]);

  const serverReady = server.baseUrl.trim().length > 0 && server.workspaceId.trim().length > 0;

  return (
    <div>
      <div className="pw-dlg-title">研究引擎</div>
      <div className="pw-dlg-desc">
        多轮检索、抓取与证据核查的本机研究引擎。开启后侧栏会出现「研究」入口。
      </div>

      <SettingCard title="功能开关">
        <FlagRow
          label="启用研究引擎"
          desc="总开关。关闭时不启动检索进程，侧栏也不显示入口。"
          value={settings.enabled}
          onChange={(v) => patch({ enabled: v })}
        />
        <FlagRow
          label="深度研究"
          desc="侧栏「研究」工作区：多轮检索并产出带引用的报告。"
          value={settings.deepResearchEnabled}
          onChange={(v) => patch({ deepResearchEnabled: v })}
          disabled={!settings.enabled}
        />
        <FlagRow
          label="会话内检索"
          desc="聊天里需要最新信息时，自动做一次快速检索并附引用。"
          value={settings.chatEnabled}
          onChange={(v) => patch({ chatEnabled: v })}
          disabled={!settings.enabled}
        />
        {/* 以下三项的适配器尚未落地（M1 只接了 chat 与 deep_research），一律禁用 + 标注，
            不给「点了没反应」的开关。适配器落地时把 disabled 去掉即可，无需改数据结构。 */}
        <FlagRow
          label="演示文稿检索"
          desc="为演示文稿自动收集素材与来源。"
          value={settings.slidesEnabled}
          onChange={(v) => patch({ slidesEnabled: v })}
          disabled
          badge={COMING_SOON_BADGE}
        />
        <FlagRow
          label="写作检索"
          desc="写作工作区引用外部资料时复用研究引擎。"
          value={settings.writingEnabled}
          onChange={(v) => patch({ writingEnabled: v })}
          disabled
          badge={COMING_SOON_BADGE}
        />
        <FlagRow
          label="记忆沉淀"
          desc="把研究结论整理成记忆候选（仍需逐条批准后写入）。"
          value={settings.memoryEnabled}
          onChange={(v) => patch({ memoryEnabled: v })}
          disabled
          badge={COMING_SOON_BADGE}
        />
      </SettingCard>

      <SettingCard title="模型">
        <div className="pw-srow-desc">
          研究是长任务，一次会话的 token 消耗比一次聊天高一到两个数量级，可以在这里单独指定模型。
          留「跟随全局默认」则使用「供应商」分区里的默认模型。
        </div>
        <label className="pw-set-field">
          <span className="pw-set-lbl">研究模型供应商</span>
          {/* 换供应商时必须一并清掉 modelId：模型 id 属于某个供应商，留着旧的会在下拉里
              显示一个不属于新供应商的值（选型侧会丢弃它，但界面看着像生效了）。 */}
          <select
            className="pw-set-input"
            aria-label="研究模型供应商"
            value={settings.modelProviderId ?? ""}
            onChange={(e) => patch({ modelProviderId: e.target.value, modelId: "" })}
          >
            <option value="">跟随全局默认</option>
            {providerSettings.providers.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name?.trim() || p.id}
                {p.enabled ? "" : "（已停用）"}
              </option>
            ))}
          </select>
        </label>
        <label className="pw-set-field">
          <span className="pw-set-lbl">研究模型</span>
          <select
            className="pw-set-input"
            aria-label="研究模型"
            value={settings.modelId ?? ""}
            onChange={(e) => patch({ modelId: e.target.value })}
          >
            <option value="">跟随全局默认</option>
            {modelOptions.map((m) => (
              <option key={m.id} value={m.id}>
                {m.id}
              </option>
            ))}
          </select>
        </label>
        {/* 出站说明由所选模型是否在本机推导（core 的 describeModelEgress），
            不是一个可配置项——用户选完模型就已经决定了数据去哪。 */}
        <div className={`pw-res-notice is-${model.isLocal ? "local" : "remote"}`}>
          <div className="pw-res-notice-title">
            {model.label ? `本次研究将使用：${model.label}` : "尚未配置可用的模型"}
          </div>
          <div className="pw-res-notice-summary">{model.egressZh}</div>
        </div>
      </SettingCard>

      <SettingCard title="Search Server">
        <div className="pw-srow-desc">
          自建检索服务的连接配置。留空时研究引擎使用内置检索能力。
        </div>
        <label className="pw-set-field">
          <span className="pw-set-lbl">服务地址</span>
          <input
            className="pw-set-input"
            value={server.baseUrl}
            placeholder="https://search.example.com"
            spellCheck={false}
            onChange={(e) => patchServer({ baseUrl: e.target.value })}
          />
        </label>
        <label className="pw-set-field">
          <span className="pw-set-lbl">工作区 ID</span>
          <input
            className="pw-set-input"
            value={server.workspaceId}
            placeholder="workspace-id"
            spellCheck={false}
            onChange={(e) => patchServer({ workspaceId: e.target.value })}
          />
        </label>
        {/* PAT：password 输入，永远从空开始；已保存的令牌只以「已配置」呈现，明文与密文都不回显。 */}
        <label className="pw-set-field">
          <span className="pw-set-lbl">访问令牌（PAT）</span>
          <input
            className="pw-set-input"
            type="password"
            value={token}
            placeholder={hasToken ? "如需更换请输入新令牌" : "粘贴访问令牌"}
            spellCheck={false}
            autoComplete="off"
            onChange={(e) => setToken(e.target.value)}
          />
        </label>
        <SRow label="令牌状态" desc="令牌加密保存在本机，界面不会回显。" end>
          <span className="pw-srow-desc">{hasToken ? "已配置" : "未配置"}</span>
        </SRow>
        <div className="pw-srow">
          <div className="pw-srow-l">
            {/* 能力缺失时按钮禁用并说明原因，而不是点了静默无事（主进程对应 channel 尚未提供）。 */}
            {!canSaveCredential || !canTestServer ? (
              <span className="pw-srow-desc">当前版本尚不支持在此保存令牌或测试连接。</span>
            ) : null}
            {probeText ? <span className="pw-srow-desc">{probeText}</span> : null}
          </div>
          <div className="pw-srow-c pw-srow-c-end">
            <button
              type="button"
              className="pw-btn-sm"
              disabled={!canSaveCredential || token.length === 0 || !serverReady}
              onClick={saveToken}
            >
              保存令牌
            </button>
            <button
              type="button"
              className="pw-btn-sm"
              disabled={!canTestServer || !serverReady}
              onClick={testServer}
            >
              连接测试
            </button>
          </div>
        </div>
      </SettingCard>
    </div>
  );
}
