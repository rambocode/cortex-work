// 研究引擎（Cortex Research Engine）设置分区（P8 接线）。
//
// 三处刻意的设计，改动前请先读完：
//   1. **开关只在后端真的会读它时才可点**。曾有三个 consumer 开关是禁用 + 标「即将支持」的，
//      现在 writing / slides / memory 全部落地，禁用条件收敛为「总开关未开」。
//      给用户一个写得进配置、后端却不读的开关，比不给还糟——新增开关时守住这条。
//      同理，**这里刻意没有「会话内检索」**：聊天里的联网是会话级的（输入框「联网」pill →
//      SessionMeta.webSearch），全局再放一个开关就会出现两个真源互相打脸。
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
  type ResearchSearchBackend,
} from "@cortex-work/core/research/settings";
import {
  DIRECT_SEARCH_PROVIDER_IDS,
  DIRECT_SEARCH_PROVIDERS,
  type DirectSearchProviderId,
} from "@cortex-work/core/research/direct-search";
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

  // ── 直连搜索逃生阀 ──────────────────────────────────────────────────────────
  // 供应商下拉的本地草稿：未配置时展示第一档，用户选完但还没保存密钥也要能停在那一档上。
  const [directProvider, setDirectProvider] = useState<DirectSearchProviderId>(
    () => raw?.directSearch?.provider ?? DIRECT_SEARCH_PROVIDER_IDS[0],
  );
  // 明文 API key：只存在于这个 state，提交后立即清空，不写 store、不落盘。
  const [apiKey, setApiKey] = useState("");
  const [directProbeText, setDirectProbeText] = useState<string | null>(null);

  // 「已配置」只在**当前选中的供应商**下成立：换到另一家时旧密钥不适用（main 侧
  // mergeDirectSearchSettings 也会把它丢掉），此处必须同步显示为未配置，
  // 否则用户会以为不用再填而直接点连接测试。
  const hasApiKey =
    !!raw?.directSearch?.encryptedApiKey && raw.directSearch.provider === directProvider;
  const canSaveDirect = typeof researchBridge?.setDirectSearchCredential === "function";
  const canTestDirect = typeof researchBridge?.testDirectSearch === "function";

  /// 切换供应商：先落本地草稿，再写 store。
  /// 换供应商本身就要落盘（否则刷新后回到旧值），但**不带密钥**——
  /// 用 patch 而非 setDirectSearchCredential，避免为一次下拉切换就走加密通道。
  const selectDirectProvider = useCallback(
    (provider: DirectSearchProviderId) => {
      setDirectProvider(provider);
      setDirectProbeText(null);
      const previous = raw?.directSearch;
      patch({
        directSearch:
          previous?.provider === provider && previous.encryptedApiKey
            ? previous
            : { provider },
      });
    },
    [raw, patch],
  );

  /// 提交明文 API key：单向传给 main 加密落盘，成功与否都立刻清空输入框。
  /// 同 saveToken，**必须把 main 回传的切片写回 store**，否则下一次全量写回会抹掉密钥。
  const saveApiKey = useCallback(() => {
    const fn = researchBridge?.setDirectSearchCredential;
    if (!fn) return;
    const plain = apiKey;
    setApiKey("");
    void fn({ provider: directProvider, apiKey: plain })
      .then((saved) => {
        if (saved) patch({ directSearch: saved });
        setDirectProbeText("密钥已保存（已加密存储）");
      })
      .catch((e: unknown) =>
        setDirectProbeText(`保存失败：${e instanceof Error ? e.message : String(e)}`),
      );
  }, [researchBridge, apiKey, directProvider, patch]);

  /// 直连连通性探测：同样不传也不回传任何凭据。
  const testDirect = useCallback(() => {
    const fn = researchBridge?.testDirectSearch;
    if (!fn) return;
    setDirectProbeText("正在测试连接…");
    void fn()
      .then((r) => setDirectProbeText(r.message))
      .catch((e: unknown) =>
        setDirectProbeText(`测试失败：${e instanceof Error ? e.message : String(e)}`),
      );
  }, [researchBridge]);

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
        {/* 聊天里的联网**没有全局开关**：它是会话级的（输入框上的「联网」pill，
            落 SessionMeta.webSearch）。联网带有数据出站语义，「这次对话要不要联网」是用户
            当下的意图，不该由一个一劳永逸的全局开关替所有会话决定。

            这一项管的是「联网时的行为风格」（模型自主判断 vs 每轮强制先查），不是「是否允许
            联网」，所以留在全局。它只在会话开了「联网」时才真正生效（判定在 core 的
            shouldAutoRetrieve），故 desc 必须点明这层依赖——否则用户开了却不见联网、无从排查。 */}
        <FlagRow
          label="总是先检索再回答"
          desc="在开启了「联网」的会话里，每轮发送前都先联网查一次并附上资料，不依赖模型自己判断。会给每轮回复增加数秒延迟。"
          value={settings.chatAutoRetrieve}
          onChange={(v) => patch({ chatAutoRetrieve: v })}
          disabled={!settings.enabled}
        />
        {/* 以下三项的适配器尚未落地（M1 只接了 chat 与 deep_research），一律禁用 + 标注，
            不给「点了没反应」的开关。适配器落地时把 disabled 去掉即可，无需改数据结构。 */}
        <FlagRow
          label="演示文稿检索"
          desc="演示文稿 agent 可自行联网查资料，并把引用的来源登记在 deck 旁供演讲者核对。"
          value={settings.slidesEnabled}
          onChange={(v) => patch({ slidesEnabled: v })}
          disabled={!settings.enabled}
        />
        <FlagRow
          label="写作检索"
          desc="写作助手发消息前联网查一次资料，与工作区本地检索并行，结果附来源链接。"
          value={settings.writingEnabled}
          onChange={(v) => patch({ writingEnabled: v })}
          disabled={!settings.enabled}
        />
        <FlagRow
          label="记忆沉淀"
          desc="深度研究完成后，把报告里被引用过的结论整理成候选；须在「记忆」设置里逐条批准才写入。"
          value={settings.memoryEnabled}
          onChange={(v) => patch({ memoryEnabled: v })}
          disabled={!settings.enabled}
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

      {/* 搜索后端是**单选**，选择器与该后端的配置表单同在一张卡里——「选哪条路」和
          「这条路怎么配」是同一个功能，拆成两张卡会让用户以为是两件独立的事。
          界面上看得见的表单就是实际生效的那一条；两侧已填的地址/密钥都保留在设置里，
          来回切不用重配。 */}
      <SettingCard title="搜索后端">
        <label className="pw-set-field">
          <span className="pw-set-lbl">检索走哪条路径</span>
          <select
            className="pw-set-input"
            aria-label="搜索后端"
            value={settings.searchBackend}
            onChange={(e) => patch({ searchBackend: e.target.value as ResearchSearchBackend })}
          >
            <option value="direct">直连搜索（推荐，填一个 API 密钥即可用）</option>
            <option value="server">自建 Search Server</option>
          </select>
        </label>
        <div className="pw-srow-desc">
          {settings.searchBackend === "server"
            ? "查询词经自建服务端转发，有服务端的限流与审计。选定后仅读取下方的配置。"
            : "查询词从本机直接发送给搜索服务商，无服务端中转。选定后仅读取下方的配置。"}
        </div>

      {settings.searchBackend === "server" ? (
      <>
        {/* 这句必须如实说明未配置的后果：此处原本写的是「留空时使用内置检索能力」，
            而实际上并不存在任何内置检索——未配置时 createSearchClient() 返回 null，研究直接
            抛「搜索服务未配置」。假文案会把用户的排查方向引到完全错误的地方。
            单选后也**不再回落到直连**：选了这条就只走这条，配不全就报错。 */}
        <div className="pw-srow-desc">
          自建检索服务的连接配置。三项都填齐（含令牌）才算可用；配不全时研究会直接报「搜索服务未配置」，不会自动改走直连。
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
            {/* 两条后端各有一个「连接测试」按钮，可见文案相同（单选后同一时刻只渲染一个，
                但测试与读屏仍需要能区分）。aria-label 必须区分开。 */}
            <button
              type="button"
              className="pw-btn-sm"
              aria-label="测试 Search Server 连接"
              disabled={!canTestServer || !serverReady}
              onClick={testServer}
            >
              连接测试
            </button>
          </div>
        </div>
      </>
      ) : null}

      {settings.searchBackend === "direct" ? (
      <>
        {/* 出站提示必须显眼且如实：这条路径与自建服务端的隐私边界不同，用户有权在配置前就知道。 */}
        <div className="pw-res-notice is-remote">
          <div className="pw-res-notice-title">查询词会从本机直接发送给所选服务商</div>
          <div className="pw-res-notice-summary">
            不经 Search Server 转发，因此没有服务端的限流与审计。网页正文仍在本机抓取与处理，
            不会上传。
          </div>
        </div>
        <label className="pw-set-field">
          <span className="pw-set-lbl">搜索服务商</span>
          <select
            className="pw-set-input"
            value={directProvider}
            aria-label="搜索服务商"
            onChange={(e) => selectDirectProvider(e.target.value as DirectSearchProviderId)}
          >
            {DIRECT_SEARCH_PROVIDER_IDS.map((id) => (
              <option key={id} value={id}>
                {DIRECT_SEARCH_PROVIDERS[id].label}
              </option>
            ))}
          </select>
        </label>
        <div className="pw-srow-desc">{DIRECT_SEARCH_PROVIDERS[directProvider].hint}</div>
        {/* API key：与 PAT 同样只单向流向 main，输入框永远从空开始。 */}
        <label className="pw-set-field">
          <span className="pw-set-lbl">API 密钥</span>
          <input
            className="pw-set-input"
            type="password"
            value={apiKey}
            placeholder={hasApiKey ? "如需更换请输入新密钥" : "粘贴 API 密钥"}
            spellCheck={false}
            autoComplete="off"
            onChange={(e) => setApiKey(e.target.value)}
          />
        </label>
        <SRow label="密钥状态" desc="密钥加密保存在本机，界面不会回显。" end>
          <span className="pw-srow-desc">{hasApiKey ? "已配置" : "未配置"}</span>
        </SRow>
        <div className="pw-srow">
          <div className="pw-srow-l">
            {!canSaveDirect || !canTestDirect ? (
              <span className="pw-srow-desc">当前版本尚不支持在此保存密钥或测试连接。</span>
            ) : null}
            {directProbeText ? <span className="pw-srow-desc">{directProbeText}</span> : null}
          </div>
          <div className="pw-srow-c pw-srow-c-end">
            <button
              type="button"
              className="pw-btn-sm"
              disabled={!canSaveDirect || apiKey.length === 0}
              onClick={saveApiKey}
            >
              保存密钥
            </button>
            <button
              type="button"
              className="pw-btn-sm"
              aria-label="测试直连搜索连接"
              disabled={!canTestDirect || !hasApiKey}
              onClick={testDirect}
            >
              连接测试
            </button>
          </div>
        </div>
      </>
      ) : null}
      </SettingCard>
    </div>
  );
}
