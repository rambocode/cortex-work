// 研究引擎设置分区的接线测试（P8）。
//
// 三条红线各有一例守着，改动时不要顺手删：
//   1. M1 未实现的 consumer 开关必须禁用且标注「即将支持」——否则给用户一个点了没反应的开关；
//   2. Search Server 的 PAT **永不明文回显**（store 里只有 safeStorage 密文，UI 连密文都不展示）；
//   3. 「用哪个模型 + 数据会去哪」显示的必须是**实际生效**的那个（core 的 selectResearchModel
//      会把失效偏好静默降级），否则用户以为在用 A、其实跑的是 B。
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from "vitest";
import { CoreProvider, usePersonalStore, type DesktopBridge } from "@cortex-work/core";
import { i18nReady } from "@cortex-work/core/i18n";
import type { ResearchEngineSettings } from "@cortex-work/core/research/settings";
import { ResearchSettingsSection } from "./ResearchSettingsSection";

function renderSection(bridge: DesktopBridge | null = {} as DesktopBridge) {
  return render(
    <CoreProvider wsId="test-ws" identity={{ userId: "me", name: "我" }} desktopBridge={bridge}>
      <ResearchSettingsSection />
    </CoreProvider>,
  );
}

/// 直接写 store 的 researchEngine 切片（设置页的真源就是 generalSettings）。
function setResearch(patch: Partial<ResearchEngineSettings>): void {
  usePersonalStore.setState((s) => ({
    generalSettings: {
      ...s.generalSettings,
      researchEngine: {
        enabled: true,
        deepResearchEnabled: true,
        chatEnabled: false,
        chatAutoRetrieve: false,
        slidesEnabled: false,
        writingEnabled: false,
        memoryEnabled: false,
        ...patch,
      },
    },
  }));
}

const research = () => usePersonalStore.getState().generalSettings.researchEngine;

beforeAll(async () => {
  await i18nReady;
});

beforeEach(() => {
  usePersonalStore.setState((s) => ({
    generalSettings: { ...s.generalSettings, researchEngine: undefined },
  }));
});

afterEach(() => cleanup());

describe("ResearchSettingsSection 功能开关", () => {
  it("缺省（generalSettings 无 researchEngine）时总开关关闭且不抛错", () => {
    renderSection();
    expect(screen.getByRole("switch", { name: "启用研究引擎" }).getAttribute("aria-checked")).toBe(
      "false",
    );
  });

  it("切总开关写入 generalSettings.researchEngine.enabled", () => {
    renderSection();
    fireEvent.click(screen.getByRole("switch", { name: "启用研究引擎" }));
    expect(research()?.enabled).toBe(true);
  });

  it("已实现的 consumer 开关（深度研究 / 会话内检索）可点击并落库", () => {
    setResearch({ enabled: true, deepResearchEnabled: false });
    renderSection();
    fireEvent.click(screen.getByRole("switch", { name: "深度研究" }));
    expect(research()?.deepResearchEnabled).toBe(true);
    fireEvent.click(screen.getByRole("switch", { name: "会话内检索" }));
    expect(research()?.chatEnabled).toBe(true);
  });

  it("「总是先检索再回答」依赖「会话内检索」：后者关闭时禁用且点不动", () => {
    setResearch({ enabled: true, chatEnabled: false });
    renderSection();
    const auto = screen.getByRole("switch", { name: "总是先检索再回答" });
    expect(auto.hasAttribute("disabled")).toBe(true);
    fireEvent.click(auto);
    expect(research()?.chatAutoRetrieve).toBe(false);
  });

  it("会话内检索开启后，「总是先检索再回答」可点击并落库", () => {
    setResearch({ enabled: true, chatEnabled: true });
    renderSection();
    fireEvent.click(screen.getByRole("switch", { name: "总是先检索再回答" }));
    expect(research()?.chatAutoRetrieve).toBe(true);
  });

  /// 曾有三个 consumer 开关是禁用 + 标「即将支持」的；四个 consumer 全部落地后，
  /// 页面上不该再残留任何「即将支持」角标——留着会让用户以为功能还没做。
  it("不再有「即将支持」的占位开关", () => {
    setResearch({ enabled: true });
    renderSection();
    expect(screen.queryAllByText("即将支持")).toHaveLength(0);
  });

  it.each([
    ["写作检索", "writingEnabled"],
    ["演示文稿检索", "slidesEnabled"],
    ["记忆沉淀", "memoryEnabled"],
  ] as const)("%s 已落地：可点击并落库", (name, key) => {
    setResearch({ enabled: true });
    renderSection();
    const sw = screen.getByRole("switch", { name });
    expect(sw.hasAttribute("disabled")).toBe(false);
    fireEvent.click(sw);
    expect(research()?.[key]).toBe(true);
  });

  /// 总开关是所有 consumer 开关的前置条件：引擎没开时后端根本不会读它们。
  it("总开关关闭时全部 consumer 开关禁用", () => {
    setResearch({ enabled: false });
    renderSection();
    for (const name of ["深度研究", "会话内检索", "写作检索", "演示文稿检索", "记忆沉淀"]) {
      expect(screen.getByRole("switch", { name }).hasAttribute("disabled")).toBe(true);
    }
  });
});

/// 造两个供应商：一个本机 loopback、一个云端，用于验证出站说明随所选模型变化。
function setProviders(): void {
  usePersonalStore.setState({
    providerSettings: {
      providers: [
        {
          id: "ollama",
          name: "本机 Ollama",
          baseUrl: "http://localhost:11434/v1",
          endpointFormat: "chat_completions",
          models: [{ id: "qwen3:8b" }, { id: "llama3.1" }],
          enabled: true,
        },
        {
          id: "deepseek",
          name: "DeepSeek",
          baseUrl: "https://api.deepseek.com/v1",
          endpointFormat: "chat_completions",
          models: [{ id: "deepseek-chat" }, { id: "deepseek-reasoner" }],
          enabled: true,
        },
      ],
      defaultProviderId: "deepseek",
      defaultModel: "deepseek-chat",
    },
  });
}

describe("ResearchSettingsSection 研究模型", () => {
  beforeEach(() => setProviders());

  it("缺省跟随全局默认模型，并说明证据正文会出站", () => {
    setResearch({ enabled: true });
    const { container } = renderSection();
    expect(container.textContent).toContain("本次研究将使用：DeepSeek / deepseek-chat");
    expect(container.textContent).toContain("发送给所选的模型供应商");
  });

  it("选本机模型后出站说明改为「不会离开这台设备」", () => {
    setResearch({ enabled: true });
    const { container } = renderSection();

    fireEvent.change(screen.getByLabelText("研究模型供应商"), { target: { value: "ollama" } });
    expect(research()?.modelProviderId).toBe("ollama");
    expect(container.textContent).toContain("本次研究将使用：本机 Ollama / qwen3:8b");
    expect(container.textContent).toContain("不会离开这台设备");
  });

  it("模型下拉只列生效供应商名下的模型（不串别家的）", () => {
    setResearch({ enabled: true, modelProviderId: "ollama" });
    renderSection();

    const options = Array.from(
      (screen.getByLabelText("研究模型") as HTMLSelectElement).options,
    ).map((o) => o.value);
    expect(options).toEqual(["", "qwen3:8b", "llama3.1"]);
    expect(options).not.toContain("deepseek-chat");
  });

  it("换供应商时清掉旧的 modelId（模型 id 属于某个供应商，留着会显示一个不生效的值）", () => {
    setResearch({ enabled: true, modelProviderId: "deepseek", modelId: "deepseek-reasoner" });
    renderSection();

    fireEvent.change(screen.getByLabelText("研究模型供应商"), { target: { value: "ollama" } });
    // 归一化把空串折叠成 undefined，所以这里断言「没有值」而不是空串。
    expect(research()?.modelId ?? "").toBe("");
  });

  it("偏好指向已删除的供应商时，显示的是实际会用的那个", () => {
    setResearch({ enabled: true, modelProviderId: "已删除的供应商", modelId: "已删除的模型" });
    const { container } = renderSection();
    expect(container.textContent).toContain("本次研究将使用：DeepSeek / deepseek-chat");
    expect(container.textContent).not.toContain("已删除");
  });

  it("一个供应商都没配时给出引导文案而不是空白", () => {
    usePersonalStore.setState({ providerSettings: { providers: [] } });
    setResearch({ enabled: true });
    const { container } = renderSection();
    expect(container.textContent).toContain("尚未配置可用的模型");
    expect(container.textContent).toContain("请先在设置中添加并启用");
  });
});

describe("ResearchSettingsSection Search Server 凭据", () => {
  it("PAT 输入是 password 类型，且已保存的密文永不回显", () => {
    setResearch({
      enabled: true,
      searchServer: {
        baseUrl: "https://search.example.com",
        workspaceId: "ws-1",
        encryptedToken: "ENCRYPTED-SECRET-XYZ",
      },
    });
    const { container } = renderSection();
    const pat = screen.getByLabelText("访问令牌（PAT）") as HTMLInputElement;
    expect(pat.type).toBe("password");
    expect(pat.value).toBe("");
    // 密文本身也不出现在 DOM 任何位置（含 title/value 属性）。
    expect(container.innerHTML).not.toContain("ENCRYPTED-SECRET-XYZ");
    expect(container.textContent).toContain("已配置");
  });

  it("未配置时展示「未配置」而非空白", () => {
    setResearch({ enabled: true });
    const { container } = renderSection();
    expect(container.textContent).toContain("未配置");
  });

  it("baseUrl / workspaceId 落库时保留已有密文（不 clobber main 写入的加密令牌）", () => {
    setResearch({
      enabled: true,
      searchServer: { baseUrl: "https://old", workspaceId: "ws-1", encryptedToken: "CIPHER" },
    });
    renderSection();
    fireEvent.change(screen.getByLabelText("服务地址"), {
      target: { value: "https://search.example.com" },
    });
    expect(research()?.searchServer?.baseUrl).toBe("https://search.example.com");
    expect(research()?.searchServer?.encryptedToken).toBe("CIPHER");
  });

  it("桥缺 setSearchServerCredential / testSearchServer 时按钮禁用并说明原因（优雅降级）", () => {
    setResearch({ enabled: true });
    renderSection({} as DesktopBridge);
    expect((screen.getByRole("button", { name: "保存令牌" }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole("button", { name: "测试 Search Server 连接" }) as HTMLButtonElement).disabled).toBe(true);
    // Search Server 与直连搜索两张卡各说明一次：两条路径的降级提示都要出现，
    // 否则用户只看到一半，会以为另一条路可用。
    expect(screen.getAllByText(/当前版本尚不支持/)).toHaveLength(2);
    expect((screen.getByRole("button", { name: "保存密钥" }) as HTMLButtonElement).disabled).toBe(true);
    expect(
      (screen.getByRole("button", { name: "测试直连搜索连接" }) as HTMLButtonElement).disabled,
    ).toBe(true);
  });

  it("桥提供能力时：保存只单向传明文一次，测试结果直接展示", async () => {
    setResearch({
      enabled: true,
      searchServer: { baseUrl: "https://search.example.com", workspaceId: "ws-1" },
    });
    const setCred = vi.fn(async () => {});
    const testConn = vi.fn(async () => ({ ok: true, message: "连接成功：workspace ws-1" }));
    renderSection({
      research: { setSearchServerCredential: setCred, testSearchServer: testConn },
    } as unknown as DesktopBridge);

    const pat = screen.getByLabelText("访问令牌（PAT）") as HTMLInputElement;
    fireEvent.change(pat, { target: { value: "pat-plain-123" } });
    fireEvent.click(screen.getByRole("button", { name: "保存令牌" }));
    expect(setCred).toHaveBeenCalledWith({
      baseUrl: "https://search.example.com",
      workspaceId: "ws-1",
      token: "pat-plain-123",
    });
    // 提交后立即清空输入框：明文不在渲染进程多停留一秒。
    await vi.waitFor(() => expect(pat.value).toBe(""));

    fireEvent.click(screen.getByRole("button", { name: "测试 Search Server 连接" }));
    await vi.waitFor(() => expect(screen.getByText(/连接成功：workspace ws-1/)).toBeTruthy());
    // 测试探测不接受任何凭据入参（凭据由 main 自行解密）。
    expect(testConn).toHaveBeenCalledWith();
  });

  /// 回归：main 加密落盘后，renderer 的 store 副本里没有 encryptedToken。
  /// 若不把 main 返回的密文写回 store，用户随后动任何一个开关都会用这份缺密文的副本
  /// 全量覆盖磁盘，**把刚保存的 PAT 抹掉**（patch() 以 raw.searchServer 为基线）。
  it("保存令牌后把 main 返回的密文写回 store，后续改开关不会把令牌弄丢", async () => {
    setResearch({
      enabled: true,
      searchServer: { baseUrl: "https://search.example.com", workspaceId: "ws-1" },
    });
    const setCred = vi.fn(async () => ({
      baseUrl: "https://search.example.com",
      workspaceId: "ws-1",
      encryptedToken: "CIPHER-FROM-MAIN",
    }));
    renderSection({
      research: { setSearchServerCredential: setCred, testSearchServer: vi.fn() },
    } as unknown as DesktopBridge);

    fireEvent.change(screen.getByLabelText("访问令牌（PAT）"), { target: { value: "pat-plain" } });
    fireEvent.click(screen.getByRole("button", { name: "保存令牌" }));

    // 密文回写 store → 令牌状态从「未配置」变「已配置」。
    await vi.waitFor(() =>
      expect(research()?.searchServer?.encryptedToken).toBe("CIPHER-FROM-MAIN"),
    );
    expect(screen.getByText("已配置")).toBeTruthy();

    // 再动一个无关开关：全量写回时密文必须还在。
    fireEvent.click(screen.getByRole("switch", { name: "会话内检索" }));
    expect(research()?.searchServer?.encryptedToken).toBe("CIPHER-FROM-MAIN");
  });
});

describe("ResearchSettingsSection 直连搜索", () => {
  it("明确告知查询词会直接出站（隐私边界与自建服务端不同，用户配置前就该知道）", () => {
    setResearch({ enabled: true });
    renderSection();
    expect(screen.getByText(/查询词会从本机直接发送给所选服务商/)).toBeTruthy();
  });

  it("切换供应商写入 store，但不经加密通道（一次下拉切换不该走保存密钥的路径）", () => {
    setResearch({ enabled: true });
    const setCred = vi.fn(async () => ({ provider: "tavily" as const }));
    renderSection({
      research: { setDirectSearchCredential: setCred, testDirectSearch: vi.fn() },
    } as unknown as DesktopBridge);

    fireEvent.change(screen.getByLabelText("搜索服务商"), { target: { value: "tavily" } });
    expect(research()?.directSearch?.provider).toBe("tavily");
    expect(setCred).not.toHaveBeenCalled();
  });

  it("换供应商后密钥状态显示为未配置（旧家的 key 在新家必然无效）", () => {
    setResearch({
      enabled: true,
      directSearch: { provider: "brave", encryptedApiKey: "CIPHER" },
    });
    renderSection();
    // 初始停在 brave，已配置。
    expect(screen.getByText("已配置")).toBeTruthy();

    fireEvent.change(screen.getByLabelText("搜索服务商"), { target: { value: "tavily" } });
    expect(screen.queryByText("已配置")).toBeNull();
  });

  it("保存密钥：明文只单向传一次并立即清空，密文回写 store", async () => {
    setResearch({ enabled: true });
    const setCred = vi.fn(async () => ({
      provider: "brave" as const,
      encryptedApiKey: "CIPHER-FROM-MAIN",
    }));
    renderSection({
      research: { setDirectSearchCredential: setCred, testDirectSearch: vi.fn() },
    } as unknown as DesktopBridge);

    const input = screen.getByLabelText("API 密钥") as HTMLInputElement;
    fireEvent.change(input, { target: { value: "sk-plain-123" } });
    fireEvent.click(screen.getByRole("button", { name: "保存密钥" }));

    expect(setCred).toHaveBeenCalledWith({ provider: "brave", apiKey: "sk-plain-123" });
    await vi.waitFor(() => expect(input.value).toBe(""));
    // 同 PAT 的回归点：不回写密文的话，下一次全量写回会把刚存的密钥抹掉。
    await vi.waitFor(() =>
      expect(research()?.directSearch?.encryptedApiKey).toBe("CIPHER-FROM-MAIN"),
    );

    fireEvent.click(screen.getByRole("switch", { name: "会话内检索" }));
    expect(research()?.directSearch?.encryptedApiKey).toBe("CIPHER-FROM-MAIN");
  });

  it("未保存密钥时连接测试禁用（避免必然失败的一次调用）", () => {
    setResearch({ enabled: true });
    renderSection({
      research: { setDirectSearchCredential: vi.fn(), testDirectSearch: vi.fn() },
    } as unknown as DesktopBridge);
    expect(
      (screen.getByRole("button", { name: "测试直连搜索连接" }) as HTMLButtonElement).disabled,
    ).toBe(true);
  });

  it("连接测试结果直接展示，且不接受任何凭据入参", async () => {
    setResearch({
      enabled: true,
      directSearch: { provider: "brave", encryptedApiKey: "CIPHER" },
    });
    const testFn = vi.fn(async () => ({ ok: false, message: "Brave Search API 拒绝了这个密钥" }));
    renderSection({
      research: { setDirectSearchCredential: vi.fn(), testDirectSearch: testFn },
    } as unknown as DesktopBridge);

    fireEvent.click(screen.getByRole("button", { name: "测试直连搜索连接" }));
    await vi.waitFor(() => expect(screen.getByText(/拒绝了这个密钥/)).toBeTruthy());
    expect(testFn).toHaveBeenCalledWith();
  });
});
