// Provider 管理页（阶段③重构）与全局模型选择器的回归测试。
//
// 覆盖计划 §4.2 / §5 的验收点：
//   · 认证五态渲染（未配置 / safeStorage / OAuth / 环境变量 / 系统凭据）；
//   · 能力**不可由用户修改** —— 内建 Provider 详情里没有任何能力相关的可交互控件（事故根因回归）；
//   · 只读能力展示与搜索；
//   · ambient 凭据不可删除（禁用 + 说明原因）；
//   · 连接测试的费用提示（确认前不得发起调用）；
//   · safeStorage 不可用 → 只读降级；
//   · Catalog 不可用 → 明确降级提示，不白屏不崩；
//   · 模型选择器：搜索、徽标、requireImage 过滤、键盘全流程。

import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ReactElement } from "react";
import { CoreProvider, resetProviderCatalogCache, usePersonalStore } from "@cortex-work/core";
import type { DesktopBridge } from "@cortex-work/core";
import { ProviderManagerModal } from "../ProviderManagerModal";
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
        // 五态各占一个：safe-storage(api-key) / safe-storage(oauth) / env / ambient / none(local 免认证)
        { providerId: "openai", configured: true, type: "api-key", source: "env" },
        { providerId: "anthropic", configured: true, type: "oauth", source: "safe-storage", expiresAt: 1_800_000_000_000 },
        { providerId: "bedrock", configured: true, source: "ambient" },
      ],
      health: o.storageAvailable === false ? { available: false, reason: "libsecret 缺失" } : { available: true },
      hiddenProviderIds: o.hidden ?? [],
    })),
    providerCustomList: vi.fn(async () => []),
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

beforeEach(() => {
  resetProviderCatalogCache();
  usePersonalStore.setState({ legacyProviderSettingsCleared: undefined });
});
afterEach(() => cleanup());

describe("Provider 管理页：认证状态与降级", () => {
  it("左栏区分五种认证状态", async () => {
    renderUI(<ProviderManagerModal onClose={() => {}} />, makeBridge());
    // 未配置（local 无需认证 → source=none）
    expect(await screen.findByText("环境变量")).toBeInTheDocument();
    expect(screen.getAllByText("已登录（OAuth）").length).toBeGreaterThan(0);
    expect(screen.getAllByText("系统凭据").length).toBeGreaterThan(0);
    expect(screen.getAllByText("未配置").length).toBeGreaterThan(0);
  });

  it("safeStorage 不可用 → 只读警告条 + 密钥输入被禁用", async () => {
    renderUI(<ProviderManagerModal onClose={() => {}} />, makeBridge({ storageAvailable: false }));
    // 弹窗顶部一条全局警告 + 详情面板一条，两处都在（全局说明影响面，详情说明本页禁用原因）。
    expect((await screen.findAllByText(/系统密钥库不可用/)).length).toBeGreaterThan(0);
    fireEvent.click(screen.getAllByText("OpenAI")[0]!);
    const key = screen.getByPlaceholderText("粘贴该供应商的 API Key") as HTMLInputElement;
    expect(key.disabled).toBe(true);
  });

  it("Catalog 不可用 → 明确降级提示，不白屏", async () => {
    renderUI(<ProviderManagerModal onClose={() => {}} />, makeBridge({ catalogOk: false }));
    expect(await screen.findByText(/模型目录不可用/)).toBeInTheDocument();
  });

  it("桥不支持（Web 端）→ 「桌面端专属」提示", async () => {
    renderUI(<ProviderManagerModal onClose={() => {}} />, null);
    expect(await screen.findByText("供应商管理仅在桌面端可用。")).toBeInTheDocument();
  });

  it("旧配置被首启清理 → 一次性提示，点「知道了」后置 noticeAcknowledged", async () => {
    usePersonalStore.setState({ legacyProviderSettingsCleared: { at: 1 } });
    const { rerender } = renderUI(<ProviderManagerModal onClose={() => {}} />, makeBridge());
    expect(await screen.findByText(/供应商配置已升级/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "知道了" }));
    // 标记随下一次全量保存落盘（toPersistedState 白名单里已透传），之后不再弹。
    expect(usePersonalStore.getState().legacyProviderSettingsCleared?.noticeAcknowledged).toBe(true);
    rerender(
      <CoreProvider wsId="ws" identity={{ userId: "me", name: "我" }} desktopBridge={makeBridge()}>
        <ProviderManagerModal onClose={() => {}} />
      </CoreProvider>,
    );
    expect(screen.queryByText(/供应商配置已升级/)).toBeNull();
  });

  it("ambient 凭据不可删除：注销按钮禁用并说明去哪儿删", async () => {
    renderUI(<ProviderManagerModal onClose={() => {}} />, makeBridge());
    fireEvent.click(await screen.findByText("Bedrock"));
    const logout = (await screen.findByRole("button", { name: /注销/ })) as HTMLButtonElement;
    expect(logout.disabled).toBe(true);
    expect(screen.getByText(/Cortex 只能读取、不能删除/)).toBeInTheDocument();
  });
});

describe("Provider 管理页：能力只读（事故根因回归）", () => {
  it("内建 Provider 详情里没有任何能力编辑控件", async () => {
    const { container } = renderUI(<ProviderManagerModal onClose={() => {}} />, makeBridge());
    // 左栏按名称排序（Anthropic 在前），显式切到 OpenAI 再断言其模型列表。
    fireEvent.click(await screen.findByText("OpenAI"));
    await screen.findByText("GPT Vision");
    // 事故根因是「用户勾选推理/视觉、手填上下文」被写进 extension 覆盖 pi 内置目录。
    // 因此这里断言：不存在任何 checkbox（能力开关）、也没有「添加模型 / 删除模型」入口。
    expect(container.querySelectorAll('input[type="checkbox"]').length).toBe(0);
    expect(screen.queryByText("添加模型")).toBeNull();
    expect(screen.queryByText("从 API 拉取")).toBeNull();
    expect(screen.getByText(/是系统元数据，不可编辑/)).toBeInTheDocument();
  });

  it("只读模型列表展示完整能力，并可按 id / 名称搜索", async () => {
    renderUI(<ProviderManagerModal onClose={() => {}} />, makeBridge());
    fireEvent.click(await screen.findByText("OpenAI"));
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

describe("Provider 管理页：连接测试的费用提示", () => {
  it("点「测试连接」先出费用确认，确认前不得发起调用", async () => {
    const test = vi.fn(async () => ({ ok: true, modelId: "gpt-vision", latencyMs: 42 }));
    renderUI(<ProviderManagerModal onClose={() => {}} />, makeBridge({ connectionTest: test }));
    fireEvent.click(await screen.findByRole("button", { name: /测试连接/ }));
    expect(screen.getByText("连接测试会真实调用一次模型")).toBeInTheDocument();
    expect(test).not.toHaveBeenCalled(); // 关键：确认前一次调用都不能发出去（会产生费用）

    fireEvent.click(screen.getByRole("button", { name: "确认测试" }));
    await waitFor(() => expect(test).toHaveBeenCalledTimes(1));
    expect(await screen.findByText(/连接正常/)).toBeInTheDocument();
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
    // 候选顺序按 Provider 名排序（Anthropic → Bedrock → Local → OpenAI），↓ 一次落到第二项。
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
