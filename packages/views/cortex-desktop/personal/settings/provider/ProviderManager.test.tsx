// 供应商平铺页（设置→Pi 内联，替代旧弹窗）与全局模型选择器的回归测试。
//
// 覆盖计划 §4.2 / §5 的验收点（与弹窗时代一致，载体换成平铺页）：
//   · 认证形态分区渲染（订阅登录 / API Key / 环境变量 / 系统凭据 / 免认证本地端点）；
//   · 能力**不可由用户修改** —— 展开的模型列表里没有任何能力相关的可交互控件（事故根因回归）；
//   · 只读能力展示与搜索；
//   · ambient 凭据不可删除（禁用 + 说明原因）；
//   · 连接测试的费用提示（确认前不得发起调用）；
//   · safeStorage 不可用 → 只读降级；
//   · Catalog 不可用 → 明确降级提示，不白屏不崩；
//   · 默认模型级联下拉：只列可用供应商、悬空引用阻断不回退；
//   · 模型选择器：搜索、徽标、requireImage 过滤、键盘全流程。

import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ReactElement } from "react";
import { CoreProvider, resetProviderCatalogCache, usePersonalStore } from "@cortex-work/core";
import type { DesktopBridge } from "@cortex-work/core";
import { PiProvidersSection } from "./PiProvidersSection";
import { DefaultModelSelects } from "./DefaultModelSelects";
import { ModelPicker } from "./ModelPicker";

const CATALOG = {
  schemaVersion: 1,
  piVersion: "0.82.1",
  hash: "t",
  providers: [
    {
      id: "openai",
      name: "OpenAI",
      api: "openai-responses",
      auth: ["api-key"],
      envVars: ["OPENAI_API_KEY"],
      models: [
        { id: "gpt-vision", name: "GPT Vision", api: "openai-responses", input: ["text", "image"], reasoning: true, contextWindow: 272000, maxTokens: 128000, cost: { input: 1.25, output: 10 } },
        { id: "gpt-text", name: "GPT Text", api: "openai-responses", input: ["text"], reasoning: false, contextWindow: 128000, maxTokens: 8192 },
      ],
    },
    {
      id: "anthropic",
      name: "Anthropic",
      api: "anthropic-messages",
      auth: ["oauth", "api-key"],
      models: [
        { id: "claude-x", name: "Claude X", api: "anthropic-messages", input: ["text", "image"], reasoning: true, contextWindow: 200000, maxTokens: 64000 },
      ],
    },
    {
      id: "bedrock",
      name: "Bedrock",
      api: "anthropic-messages",
      auth: ["ambient"],
      models: [
        { id: "bedrock-claude", name: "Bedrock Claude", api: "anthropic-messages", input: ["text"], reasoning: false, contextWindow: 200000, maxTokens: 8192 },
      ],
    },
    {
      id: "local",
      name: "Local",
      api: "openai-completions",
      auth: [],
      models: [
        { id: "qwen-local", name: "Qwen Local", api: "openai-completions", input: ["text"], reasoning: false, contextWindow: 32000, maxTokens: 4096 },
      ],
    },
    {
      // 未配置的纯 api-key Provider：API Key 分区应渲染成「粘贴即存」的输入行。
      id: "deepseek",
      name: "DeepSeek",
      api: "openai-completions",
      auth: ["api-key"],
      envVars: ["DEEPSEEK_API_KEY"],
      models: [
        { id: "ds-chat", name: "DS Chat", api: "openai-completions", input: ["text"], reasoning: false, contextWindow: 64000, maxTokens: 8192 },
      ],
    },
  ],
};

interface BridgeOpts {
  catalogOk?: boolean;
  storageAvailable?: boolean;
  hidden?: string[];
  connectionTest?: DesktopBridge["providerConnectionTest"];
}

function makeBridge(o: BridgeOpts = {}): DesktopBridge {
  return {
    providerCatalogGet: vi.fn(async () =>
      o.catalogOk === false ? { ok: false, error: "hash mismatch" } : { ok: true, catalog: CATALOG },
    ),
    providerAuthStatus: vi.fn(async () => ({
      statuses: [
        // 认证形态各占一个：env(api-key) / safe-storage(oauth) / ambient；
        // local 免认证、deepseek 未配置 → 不出现在 statuses 里。
        { providerId: "openai", configured: true, type: "api-key", source: "env" },
        { providerId: "anthropic", configured: true, type: "oauth", source: "safe-storage", expiresAt: 1_800_000_000_000 },
        { providerId: "bedrock", configured: true, source: "ambient" },
      ],
      health: o.storageAvailable === false ? { available: false, reason: "libsecret 缺失" } : { available: true },
      hiddenProviderIds: o.hidden ?? [],
    })),
    providerCustomList: vi.fn(async () => []),
    providerCustomSave: vi.fn(async () => ({ ok: true })),
    providerAuthSetSecrets: vi.fn(async () => ({ ok: true })),
    providerAuthSetApiKey: vi.fn(async () => ({ ok: true })),
    providerAuthLogout: vi.fn(async () => ({ ok: true })),
    providerAuthSetHidden: vi.fn(async () => ({ ok: true })),
    providerConnectionTest: o.connectionTest ?? vi.fn(async () => ({ ok: true, modelId: "gpt-vision", latencyMs: 42 })),
    onProviderAuthEvent: vi.fn(() => () => undefined),
    providerAuthLogin: vi.fn(async () => ({ ok: true })),
  } as unknown as DesktopBridge;
}

function renderUI(ui: ReactElement, bridge: DesktopBridge | null) {
  return render(
    <CoreProvider wsId="ws" identity={{ userId: "me", name: "我" }} desktopBridge={bridge}>
      {ui}
    </CoreProvider>,
  );
}

/** 找到某 Provider 在 API Key 分区里的整行容器（行内按钮太多，断言必须限定作用域）。 */
async function findKeyRow(name: string): Promise<HTMLElement> {
  const label = await screen.findByText(name);
  const row = label.closest(".pw-pip-row");
  if (!row) throw new Error(`row of ${name} not found`);
  return row as HTMLElement;
}

beforeEach(() => {
  resetProviderCatalogCache();
  usePersonalStore.setState({ legacyProviderSettingsCleared: undefined, defaultModelRef: undefined });
});
afterEach(() => cleanup());

describe("Pi 供应商平铺页：认证状态与降级", () => {
  it("按认证形态分区渲染：订阅卡已登录、env/ambient 徽标、免认证说明、未配置输入行", async () => {
    renderUI(<PiProvidersSection />, makeBridge());
    // 订阅登录卡（anthropic oauth）→ 绿色「已登录」
    expect(await screen.findByText("已登录")).toBeInTheDocument();
    // API Key 分区：openai 凭据来自环境变量、bedrock 来自系统凭据
    expect(screen.getByText("环境变量")).toBeInTheDocument();
    expect(screen.getByText("系统凭据")).toBeInTheDocument();
    // local 免认证 → 本地端点说明
    expect(screen.getByText("该供应商无需登录（本地端点）。")).toBeInTheDocument();
    // deepseek 未配置 → 粘贴即存的密码输入行
    expect(screen.getByLabelText("DeepSeek API Key")).toBeInTheDocument();
  });

  it("safeStorage 不可用 → 只读警告条 + 密钥输入被禁用", async () => {
    renderUI(<PiProvidersSection />, makeBridge({ storageAvailable: false }));
    expect((await screen.findAllByText(/系统密钥库不可用/)).length).toBeGreaterThan(0);
    const key = (await screen.findByLabelText("DeepSeek API Key")) as HTMLInputElement;
    expect(key.disabled).toBe(true);
  });

  it("Catalog 不可用 → 明确降级提示，不白屏", async () => {
    renderUI(<PiProvidersSection />, makeBridge({ catalogOk: false }));
    expect(await screen.findByText(/模型目录不可用/)).toBeInTheDocument();
  });

  it("桥不支持（Web 端）→ 「桌面端专属」提示", async () => {
    renderUI(<PiProvidersSection />, null);
    expect(await screen.findByText("供应商管理仅在桌面端可用。")).toBeInTheDocument();
  });

  it("旧配置被首启清理 → 一次性提示，点「知道了」后置 noticeAcknowledged", async () => {
    usePersonalStore.setState({ legacyProviderSettingsCleared: { at: 1 } });
    const { rerender } = renderUI(<PiProvidersSection />, makeBridge());
    expect(await screen.findByText(/供应商配置已升级/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "知道了" }));
    // 标记随下一次全量保存落盘（toPersistedState 白名单里已透传），之后不再弹。
    expect(usePersonalStore.getState().legacyProviderSettingsCleared?.noticeAcknowledged).toBe(true);
    rerender(
      <CoreProvider wsId="ws" identity={{ userId: "me", name: "我" }} desktopBridge={makeBridge()}>
        <PiProvidersSection />
      </CoreProvider>,
    );
    expect(screen.queryByText(/供应商配置已升级/)).toBeNull();
  });

  it("ambient 凭据不可删除：「更换」禁用并说明去哪儿删", async () => {
    renderUI(<PiProvidersSection />, makeBridge());
    const row = await findKeyRow("Bedrock");
    const replace = within(row).getByRole("button", { name: "更换" }) as HTMLButtonElement;
    expect(replace.disabled).toBe(true);
    expect(within(row).getByText(/Cortex 只能读取、不能删除/)).toBeInTheDocument();
  });
});

describe("Pi 供应商平铺页：能力只读（事故根因回归）", () => {
  it("展开的模型列表里没有任何能力编辑控件", async () => {
    const { container } = renderUI(<PiProvidersSection />, makeBridge());
    const row = await findKeyRow("OpenAI");
    fireEvent.click(within(row).getByRole("button", { name: /2 模型/ }));
    await screen.findByText("GPT Vision");
    // 事故根因是「用户勾选推理/视觉、手填上下文」被写进 extension 覆盖 pi 内置目录。
    // 因此这里断言：不存在任何 checkbox（能力开关）、也没有「添加模型 / 删除模型」入口。
    expect(container.querySelectorAll('input[type="checkbox"]').length).toBe(0);
    expect(screen.queryByText("添加模型")).toBeNull();
    expect(screen.queryByText("从 API 拉取")).toBeNull();
    expect(screen.getByText(/是系统元数据，不可编辑/)).toBeInTheDocument();
  });

  it("只读模型列表展示完整能力，并可按 id / 名称搜索", async () => {
    renderUI(<PiProvidersSection />, makeBridge());
    const row = await findKeyRow("OpenAI");
    fireEvent.click(within(row).getByRole("button", { name: /2 模型/ }));
    await screen.findByText("GPT Vision");
    expect(screen.getByText("图片输入")).toBeInTheDocument();
    expect(screen.getAllByText("仅文本").length).toBeGreaterThan(0);
    expect(screen.getByText("272K 上下文")).toBeInTheDocument();
    expect(screen.getByText("最大输出 128K")).toBeInTheDocument();
    expect(screen.getByText("$1.25 / $10 每百万 token")).toBeInTheDocument();

    fireEvent.change(screen.getByLabelText("搜索模型 id 或名称"), { target: { value: "vision" } });
    expect(screen.getByText("GPT Vision")).toBeInTheDocument();
    expect(screen.queryByText("GPT Text")).toBeNull();
  });
});

describe("Pi 供应商平铺页：连接测试的费用提示", () => {
  it("点「测试」先出费用确认，确认前不得发起调用", async () => {
    const test = vi.fn(async () => ({ ok: true, modelId: "gpt-vision", latencyMs: 42 }));
    renderUI(<PiProvidersSection />, makeBridge({ connectionTest: test }));
    const row = await findKeyRow("OpenAI");
    fireEvent.click(within(row).getByRole("button", { name: /测试/ }));
    expect(screen.getByText("连接测试会真实调用一次模型")).toBeInTheDocument();
    expect(test).not.toHaveBeenCalled(); // 关键：确认前一次调用都不能发出去（会产生费用）

    fireEvent.click(screen.getByRole("button", { name: "确认测试" }));
    await waitFor(() => expect(test).toHaveBeenCalledTimes(1));
    expect(await screen.findByText(/连接正常/)).toBeInTheDocument();
  });
});

describe("自定义供应商预制表单", () => {
  /** 打开表单并用 Ollama 预设 + 能力声明填出一份可保存的配置。 */
  async function fillForm() {
    fireEvent.click(await screen.findByRole("button", { name: /添加自定义供应商/ }));
    fireEvent.click(screen.getByRole("button", { name: "Ollama" }));
    fireEvent.change(screen.getByLabelText(/模型 ID/), { target: { value: "qwen3, llama4" } });
    fireEvent.change(screen.getByLabelText(/上下文窗口/), { target: { value: "32000" } });
    fireEvent.change(screen.getByLabelText(/最大输出/), { target: { value: "4096" } });
  }

  it("预设一键填充;保存生成含完整能力声明的 Pi Provider JSON,未填 Key 不下发 apiKey", async () => {
    const bridge = makeBridge();
    renderUI(<PiProvidersSection />, bridge);
    await fillForm();
    // 预设填充 Base URL 与名称(本地服务加「本地」前缀)。
    expect((screen.getByLabelText("Base URL") as HTMLInputElement).value).toBe("http://localhost:11434/v1");
    expect((screen.getByLabelText("名称") as HTMLInputElement).value).toBe("本地 Ollama");

    fireEvent.click(screen.getByRole("button", { name: "保存供应商" }));
    const saveMock = bridge.providerCustomSave as ReturnType<typeof vi.fn>;
    await waitFor(() => expect(saveMock).toHaveBeenCalledTimes(1));
    const def = saveMock.mock.calls[0]![0] as { id: string; json: string; secretRefs: string[] };
    expect(def.id).toBe("ollama");
    expect(def.secretRefs).toEqual([]);
    const json = JSON.parse(def.json) as Record<string, unknown>;
    expect(json.baseUrl).toBe("http://localhost:11434/v1");
    expect(json.api).toBe("openai-completions");
    expect(json.apiKey).toBeUndefined(); // 没填 Key 就不写 apiKey 字段
    // 能力字段全部来自表单的显式声明(含主进程必填的全零 cost),绝无猜测缺省。
    expect(json.models).toEqual([
      { id: "qwen3", name: "qwen3", api: "openai-completions", reasoning: false, input: ["text"], contextWindow: 32000, maxTokens: 4096, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } },
      { id: "llama4", name: "llama4", api: "openai-completions", reasoning: false, input: ["text"], contextWindow: 32000, maxTokens: 4096, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } },
    ]);
    // 保存成功后表单收起,回到虚线「添加」入口。
    expect(await screen.findByRole("button", { name: /添加自定义供应商/ })).toBeInTheDocument();
  });

  it("填了 API Key:明文只进 Secret 金库,JSON 里只落 ${secret:NAME} 引用", async () => {
    const bridge = makeBridge();
    renderUI(<PiProvidersSection />, bridge);
    await fillForm();
    fireEvent.change(screen.getByLabelText(/API Key/), { target: { value: "sk-test-123" } });
    fireEvent.click(screen.getByRole("button", { name: "保存供应商" }));

    const saveMock = bridge.providerCustomSave as ReturnType<typeof vi.fn>;
    const secretsMock = bridge.providerAuthSetSecrets as ReturnType<typeof vi.fn>;
    await waitFor(() => expect(saveMock).toHaveBeenCalledTimes(1));
    // Secret 先于保存写入金库(主进程会拒绝未定义引用),且拿到的是明文真值。
    expect(secretsMock).toHaveBeenCalledWith({ CUSTOM_OLLAMA_API_KEY: "sk-test-123" });
    const def = saveMock.mock.calls[0]![0] as { json: string; secretRefs: string[] };
    expect(def.secretRefs).toEqual(["CUSTOM_OLLAMA_API_KEY"]);
    expect(def.json).not.toContain("sk-test-123"); // 明文绝不落 JSON
    expect((JSON.parse(def.json) as { apiKey?: string }).apiKey).toBe("${secret:CUSTOM_OLLAMA_API_KEY}");
  });

  it("能力声明缺失时保存按钮不可用——不猜默认值,而是逼出显式输入", async () => {
    renderUI(<PiProvidersSection />, makeBridge());
    fireEvent.click(await screen.findByRole("button", { name: /添加自定义供应商/ }));
    fireEvent.click(screen.getByRole("button", { name: "Ollama" }));
    fireEvent.change(screen.getByLabelText(/模型 ID/), { target: { value: "qwen3" } });
    // 上下文窗口 / 最大输出未填 → 禁止保存。
    expect((screen.getByRole("button", { name: "保存供应商" }) as HTMLButtonElement).disabled).toBe(true);
  });
});

describe("默认模型级联下拉", () => {
  it("只列「认证可用 ∧ 未隐藏」的供应商；切供应商落到其第一个模型", async () => {
    usePersonalStore.setState({ defaultModelRef: { providerId: "openai", modelId: "gpt-vision" } });
    renderUI(<DefaultModelSelects />, makeBridge({ hidden: ["bedrock"] }));
    const provSel = (await screen.findByLabelText("默认供应商")) as HTMLSelectElement;
    await waitFor(() => expect(provSel.value).toBe("openai"));
    // 被隐藏的 bedrock 不出现在候选里（隐藏是展示偏好，与认证解耦）。
    expect(within(provSel).queryByText("Bedrock")).toBeNull();
    expect(within(provSel).getByText("Local")).toBeInTheDocument();

    fireEvent.change(provSel, { target: { value: "local" } });
    expect(usePersonalStore.getState().defaultModelRef).toEqual({ providerId: "local", modelId: "qwen-local" });
  });

  it("悬空引用进入阻断态并保留原始值，不自动回退到任何模型", async () => {
    usePersonalStore.setState({ defaultModelRef: { providerId: "gone", modelId: "ghost" } });
    renderUI(<DefaultModelSelects />, makeBridge());
    expect(await screen.findByText(/不会替你回退到别的模型/)).toBeInTheDocument();
    // 引用保持原样——阻断而非静默改写。
    expect(usePersonalStore.getState().defaultModelRef).toEqual({ providerId: "gone", modelId: "ghost" });
  });
});

describe("全局模型选择器", () => {
  it("只列「认证可用 ∧ 未隐藏」的 Provider 的模型", async () => {
    // openai(env) / anthropic(oauth) / bedrock(ambient) 已认证；local 无需认证 → 也应出现。
    renderUI(<ModelPicker onSelect={() => {}} />, makeBridge({ hidden: ["bedrock"] }));
    expect(await screen.findByText("GPT Vision")).toBeInTheDocument();
    expect(screen.getByText("Qwen Local")).toBeInTheDocument();
    // 被用户隐藏的 Provider 不出现在选择器里（隐藏是展示偏好，与认证解耦）。
    expect(screen.queryByText("Bedrock Claude")).toBeNull();
  });

  it("requireImage 只列 input 含 image 的模型（Computer Use 必须看得见屏幕）", async () => {
    renderUI(<ModelPicker requireImage onSelect={() => {}} />, makeBridge());
    expect(await screen.findByText("GPT Vision")).toBeInTheDocument();
    expect(screen.getByText("Claude X")).toBeInTheDocument();
    expect(screen.queryByText("GPT Text")).toBeNull();
    expect(screen.queryByText("Qwen Local")).toBeNull();
  });

  it("支持按 Provider / 模型 id / 名称搜索，并展示图片与推理徽标", async () => {
    renderUI(<ModelPicker onSelect={() => {}} />, makeBridge());
    const search = await screen.findByLabelText("搜索供应商 / 模型 id / 名称");

    fireEvent.change(search, { target: { value: "anthropic" } }); // 按 Provider 名
    expect(screen.getByText("Claude X")).toBeInTheDocument();
    expect(screen.queryByText("GPT Vision")).toBeNull();

    fireEvent.change(search, { target: { value: "gpt-text" } }); // 按模型 id
    const row = screen.getByText("GPT Text").closest("button")!;
    expect(within(row).getByText("仅文本")).toBeInTheDocument();
    expect(within(row).queryByText("推理")).toBeNull();

    fireEvent.change(search, { target: { value: "GPT Vision" } }); // 按模型名
    const visionRow = screen.getByText("GPT Vision").closest("button")!;
    expect(within(visionRow).getByText("图片输入")).toBeInTheDocument();
    expect(within(visionRow).getByText("推理")).toBeInTheDocument();
  });

  it("无障碍：↑/↓ 移动高亮、Enter 选中，全流程可纯键盘完成", async () => {
    const onSelect = vi.fn();
    renderUI(<ModelPicker onSelect={onSelect} />, makeBridge());
    const search = await screen.findByLabelText("搜索供应商 / 模型 id / 名称");
    await screen.findByText("Claude X"); // 等候选加载完再走键盘流程
    fireEvent.keyDown(search, { key: "ArrowDown" });
    fireEvent.keyDown(search, { key: "Enter" });
    expect(onSelect).toHaveBeenCalledTimes(1);
    // 候选顺序按 Provider 名排序（Anthropic → Bedrock → DeepSeek → Local → OpenAI），↓ 一次落到第二项。
    expect(onSelect.mock.calls[0]![0]).toEqual({ providerId: "bedrock", modelId: "bedrock-claude" });
  });

  it("一个可用模型都没有时给出空态与「去供应商管理」入口，而不是空白列表", async () => {
    const bridge = makeBridge();
    (bridge as { providerAuthStatus?: unknown }).providerAuthStatus = vi.fn(async () => ({
      statuses: [],
      health: { available: true },
      // 免认证的 local 也隐藏掉，制造「真的一个都没有」
      hiddenProviderIds: ["local"],
    }));
    renderUI(<ModelPicker requireImage onSelect={() => {}} onOpenManager={() => {}} />, bridge);
    expect(await screen.findByText(/没有支持图片输入的可用模型/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "去供应商管理" })).toBeInTheDocument();
  });
});
