// @vitest-environment jsdom
// 发送前 vision 阻断（计划 §2.3）的回归测试。
//
// 两组断言：
//  ① 纯函数层（classifyImageSupport / checkImageSupport）：三态判定，尤其是
//     「Catalog 里查不到」必须是 unknown 而不是 unsupported——把未知当不支持会让图片被
//     静默丢弃，正是本次事故的形态（研究文档 §5.1）。
//  ② 端到端 send：**RPC（sendPiTurn→piOpen/piPrompt）与 CLI（startCli，delegate 编排）
//     两条路径都要被拦下**，且拦下后草稿完整保留——即不落盘图片（imageSave 未被调用）、
//     不写入用户消息（消息缓存为空）、composer 侧因 send 返回 false 而保留全部输入。
// core 通例是 node 纯函数测试，但 usePersonalActions 依赖 React context + bridge 注入，
// 故照 editResendAttachments.test.tsx 的 per-file jsdom + renderHook/CoreProvider 写法。

import { renderHook, act } from "@testing-library/react";
import { QueryClient } from "@tanstack/react-query";
import { describe, it, expect, beforeEach, vi } from "vitest";
import type { ReactNode } from "react";
import { CoreProvider } from "../provider";
import { usePersonalStore } from "../store/personal";
import { usePersonalActions, personalChatKeys } from "./messages";
import {
  classifyImageSupport,
  checkImageSupport,
  isDanglingModelRef,
  providerConfigFingerprint,
  resetProviderCatalogCache,
} from "./modelCapabilities";
import { __resetPiSessionsForTest } from "./pi-session";
import type { DesktopBridge } from "../desktop/bridge";
import type { ProviderCatalog } from "../desktop/provider-catalog";
import type { PendingImage, SessionMeta } from "../desktop/types";
import type { Message } from "../types";

// 最小 Catalog：一个多模态模型 + 一个纯文本模型，同一 Provider 下。
const CATALOG: ProviderCatalog = {
  schemaVersion: 1,
  piVersion: "0.82.1",
  hash: "test-hash",
  providers: [
    {
      id: "openai",
      name: "OpenAI",
      api: "openai-responses",
      auth: ["api-key"],
      models: [
        {
          id: "gpt-vision",
          name: "GPT Vision",
          api: "openai-responses",
          input: ["text", "image"],
          reasoning: true,
          contextWindow: 272_000,
          maxTokens: 128_000,
        },
        {
          id: "gpt-text",
          name: "GPT Text",
          api: "openai-responses",
          input: ["text"],
          reasoning: false,
          contextWindow: 128_000,
          maxTokens: 8_192,
        },
      ],
    },
  ],
};

const PENDING_IMAGE: PendingImage = {
  id: "p-a",
  name: "a.png",
  mimeType: "image/png",
  dataUrl: "data:image/png;base64,AAAA",
  data: new Uint8Array([0x89, 0x50, 0x4e, 0x47]).buffer,
};

function piSession(over: Partial<SessionMeta> = {}): SessionMeta {
  return {
    id: "s1",
    projectId: "p1",
    title: "会话标题", // 非默认占位标题 → autoTitle 早退，不触发 oneshotCli
    agent: "pi",
    createdAt: 1,
    updatedAt: 1,
    providerId: "openai",
    ...over,
  };
}

/**
 * 覆盖两条发送路径所需的全部桥方法。
 * `catalogOk=false` 用来验证「Catalog 加载失败」同样走 unknown 阻断（保守，不放行）。
 */
function fakeBridge(opts: { catalogOk?: boolean } = {}) {
  const providerCatalogGet = vi.fn(async () =>
    opts.catalogOk === false
      ? { ok: false as const, error: "catalog missing" }
      : { ok: true as const, catalog: CATALOG },
  );
  const imageSave = vi.fn(async () => ({ path: "/imgs/a.png" }));
  const startCli = vi.fn(async () => {});
  // ensurePiSession 要求 piOpen 返回真 sessionId，否则视为未就绪并抛错。
  const piOpen = vi.fn(async () => ({ uiSessionId: "s1", sessionId: "pi-1", sessionFile: "/pi/s1.jsonl" }));
  const piPrompt = vi.fn(async () => {});
  const bridge = {
    loadChat: async () => [],
    saveChat: vi.fn(async () => {}),
    providerCatalogGet,
    imageSave,
    startCli,
    onCliEvent: () => () => {},
    piOpen,
    piPrompt,
    onPiEvent: () => () => {},
  } as unknown as DesktopBridge;
  return { bridge, providerCatalogGet, imageSave, startCli, piOpen, piPrompt };
}

function wrapper(bridge: DesktopBridge, queryClient: QueryClient) {
  const W = ({ children }: { children: ReactNode }) => (
    <CoreProvider wsId="ws" identity={{ userId: "me", name: "我" }} desktopBridge={bridge} queryClient={queryClient}>
      {children}
    </CoreProvider>
  );
  W.displayName = "TestWrapper";
  return W;
}

beforeEach(() => {
  resetProviderCatalogCache();
  __resetPiSessionsForTest();
  usePersonalStore.setState({
    sessions: [piSession()],
    runningBySession: {},
    piRuntimeBySession: {},
    visionBlockHints: {},
    modeBlockHints: {},
    generalSettings: { ...usePersonalStore.getState().generalSettings, subagentOrchestration: false },
  });
});

describe("能力判定：三态且 unknown 独立成态", () => {
  it("多模态模型 → supported；纯文本模型 → unsupported", () => {
    expect(classifyImageSupport(CATALOG, { providerId: "openai", modelId: "gpt-vision" })).toBe("supported");
    expect(classifyImageSupport(CATALOG, { providerId: "openai", modelId: "gpt-text" })).toBe("unsupported");
  });

  it("Catalog 里查不到的模型 → unknown（绝不退化成 unsupported）", () => {
    expect(classifyImageSupport(CATALOG, { providerId: "openai", modelId: "who-knows" })).toBe("unknown");
    expect(classifyImageSupport(CATALOG, { providerId: "nope", modelId: "gpt-vision" })).toBe("unknown");
    expect(classifyImageSupport(undefined, { providerId: "openai", modelId: "gpt-vision" })).toBe("unknown");
  });

  it("Catalog 不可用（桥缺方法 / 加载失败）→ unknown，保守阻断而非放行", async () => {
    await expect(checkImageSupport(null, { providerId: "openai", modelId: "gpt-vision" })).resolves.toBe("unknown");
    const { bridge } = fakeBridge({ catalogOk: false });
    await expect(checkImageSupport(bridge, { providerId: "openai", modelId: "gpt-vision" })).resolves.toBe("unknown");
  });

  it("悬空引用判定：Catalog 中不存在或引用不完整都算悬空", () => {
    expect(isDanglingModelRef(CATALOG, { providerId: "openai", modelId: "gpt-text" })).toBe(false);
    expect(isDanglingModelRef(CATALOG, { providerId: "openai", modelId: "gone" })).toBe(true);
    expect(isDanglingModelRef(CATALOG, { providerId: "", modelId: "" })).toBe(true);
  });
});

describe("send：文本模型 + 图片 → 阻断且草稿完整保留", () => {
  it("RPC 路径（普通 pi 会话）被拦下：不 imageSave、不 piOpen/piPrompt、不写用户消息", async () => {
    const qc = new QueryClient();
    const { bridge, imageSave, piOpen, piPrompt } = fakeBridge();
    const session = piSession({ model: "gpt-text" });
    usePersonalStore.setState({ sessions: [session] });
    const { result } = renderHook(() => usePersonalActions(), { wrapper: wrapper(bridge, qc) });

    let sent: boolean | undefined;
    await act(async () => {
      sent = await result.current.send(session, "/proj", "看这张图", [], undefined, [PENDING_IMAGE]);
    });

    expect(sent).toBe(false); // 返回 false = composer 保留文本/图片/附件/编辑态
    expect(imageSave).not.toHaveBeenCalled(); // 图片没落盘 → 无孤儿文件
    expect(piOpen).not.toHaveBeenCalled();
    expect(piPrompt).not.toHaveBeenCalled();
    expect(qc.getQueryData<Message[]>(personalChatKeys.detail(session.id)) ?? []).toHaveLength(0);
    const hint = usePersonalStore.getState().visionBlockHints[session.id];
    expect(hint).toEqual({ reason: "unsupported", providerId: "openai", modelId: "gpt-text" });
  });

  it("CLI 路径（delegate 编排走 startCli）被拦下：同一判定，不 startCli", async () => {
    const qc = new QueryClient();
    const { bridge, imageSave, startCli } = fakeBridge();
    const session = piSession({ model: "gpt-text" });
    usePersonalStore.setState({
      sessions: [session],
      // 自动编排开启 → usesCliDelegate → 本会走 bridge.startCli 而非 sendPiTurn。
      generalSettings: { ...usePersonalStore.getState().generalSettings, subagentOrchestration: true },
    });
    const { result } = renderHook(() => usePersonalActions(), { wrapper: wrapper(bridge, qc) });

    let sent: boolean | undefined;
    await act(async () => {
      sent = await result.current.send(session, "/proj", "看这张图", [], undefined, [PENDING_IMAGE]);
    });

    expect(sent).toBe(false);
    expect(startCli).not.toHaveBeenCalled();
    expect(imageSave).not.toHaveBeenCalled();
    expect(qc.getQueryData<Message[]>(personalChatKeys.detail(session.id)) ?? []).toHaveLength(0);
    expect(usePersonalStore.getState().visionBlockHints[session.id]?.reason).toBe("unsupported");
  });

  it("能力未知 → 同样阻断，但 reason 与「明确不支持」不同", async () => {
    const qc = new QueryClient();
    const { bridge, imageSave, piPrompt } = fakeBridge();
    const session = piSession({ model: "mystery-model" });
    usePersonalStore.setState({ sessions: [session] });
    const { result } = renderHook(() => usePersonalActions(), { wrapper: wrapper(bridge, qc) });

    let sent: boolean | undefined;
    await act(async () => {
      sent = await result.current.send(session, "/proj", "看这张图", [], undefined, [PENDING_IMAGE]);
    });

    expect(sent).toBe(false);
    expect(imageSave).not.toHaveBeenCalled();
    expect(piPrompt).not.toHaveBeenCalled();
    expect(usePersonalStore.getState().visionBlockHints[session.id]).toEqual({
      reason: "unknown",
      providerId: "openai",
      modelId: "mystery-model",
    });
  });
});

describe("send：多模态模型 + 图片 → 正常放行", () => {
  it("图片落盘并进入 RPC 路径，且不留拦截提示", async () => {
    const qc = new QueryClient();
    const { bridge, imageSave, piPrompt } = fakeBridge();
    const session = piSession({ model: "gpt-vision" });
    usePersonalStore.setState({ sessions: [session] });
    const { result } = renderHook(() => usePersonalActions(), { wrapper: wrapper(bridge, qc) });

    await act(async () => {
      await result.current.send(session, "/proj", "看这张图", [], undefined, [PENDING_IMAGE]);
    });

    expect(imageSave).toHaveBeenCalledTimes(1);
    expect(piPrompt).toHaveBeenCalledTimes(1);
    expect(usePersonalStore.getState().visionBlockHints[session.id]).toBeUndefined();
  });

  it("纯文本发送不受影响：文本模型无图时照常发出", async () => {
    const qc = new QueryClient();
    const { bridge, providerCatalogGet, piPrompt } = fakeBridge();
    const session = piSession({ model: "gpt-text" });
    usePersonalStore.setState({ sessions: [session] });
    const { result } = renderHook(() => usePersonalActions(), { wrapper: wrapper(bridge, qc) });

    await act(async () => {
      await result.current.send(session, "/proj", "只有文字", []);
    });

    expect(piPrompt).toHaveBeenCalledTimes(1);
    // 无图不查 Catalog：发送路径零额外 IPC 开销。
    expect(providerCatalogGet).not.toHaveBeenCalled();
  });
});

describe("providerConfigFingerprint：同一供应商下的配置变更也要触发温会话重开", () => {
  // 背景：渲染端阶段②后已不持有 baseUrl/apiKey，extensionFingerprint 只能看到 providerId。
  // 若不额外派生这个指纹，用户填了自建网关覆盖、温会话却不重开 → 请求仍发往官方端点且**毫无报错**，
  // 正是「能填但不生效」那类静默失败（我们为此专门没把 Base URL 输入框做成假可用）。
  function authBridge(status: Record<string, unknown> | undefined) {
    return {
      providerAuthStatus: vi.fn(async () => ({
        statuses: status ? [status] : [],
        health: { available: true },
        hiddenProviderIds: [],
      })),
    } as unknown as DesktopBridge;
  }

  it("baseUrl 覆盖变化 → 指纹变化（换自建网关会在下一轮重开）", async () => {
    const a = await providerConfigFingerprint(
      authBridge({ providerId: "openai", configured: true, source: "safe-storage" }),
      "openai",
    );
    const b = await providerConfigFingerprint(
      authBridge({
        providerId: "openai",
        configured: true,
        source: "safe-storage",
        baseUrlOverride: "https://my-gateway/v1",
      }),
      "openai",
    );
    expect(a).not.toBe(b);
  });

  it("认证来源变化（env → safe-storage）→ 指纹变化", async () => {
    const a = await providerConfigFingerprint(
      authBridge({ providerId: "openai", configured: true, source: "env" }),
      "openai",
    );
    const b = await providerConfigFingerprint(
      authBridge({ providerId: "openai", configured: true, source: "safe-storage" }),
      "openai",
    );
    expect(a).not.toBe(b);
  });

  it("配置不变 → 指纹稳定（不会白白重开温会话）", async () => {
    const status = { providerId: "openai", configured: true, source: "safe-storage", baseUrlOverride: "https://g/v1" };
    expect(await providerConfigFingerprint(authBridge(status), "openai")).toBe(
      await providerConfigFingerprint(authBridge(status), "openai"),
    );
  });

  it("**绝不含密钥或其摘要**：指纹里只有 baseUrlOverride / configured / source 三项", async () => {
    const fp = await providerConfigFingerprint(
      authBridge({
        providerId: "openai",
        configured: true,
        source: "safe-storage",
        baseUrlOverride: "https://g/v1",
        // 就算主进程哪天不小心多塞了字段，也不能漏进指纹。
        apiKey: "sk-LEAKED",
        token: "tok-LEAKED",
      }),
      "openai",
    );
    expect(fp).not.toContain("sk-LEAKED");
    expect(fp).not.toContain("tok-LEAKED");
    expect(JSON.parse(fp!)).toEqual({
      baseUrlOverride: "https://g/v1",
      configured: true,
      source: "safe-storage",
    });
  });

  it("拿不到认证状态（Web 端 / 旧壳 / 该 provider 无状态）→ undefined，退化成只认 id，不阻断开会话", async () => {
    expect(await providerConfigFingerprint(null, "openai")).toBeUndefined();
    expect(await providerConfigFingerprint(authBridge(undefined), "openai")).toBeUndefined();
    expect(await providerConfigFingerprint(authBridge({ providerId: "other" }), "openai")).toBeUndefined();
    expect(await providerConfigFingerprint(authBridge({ providerId: "openai" }), undefined)).toBeUndefined();
  });

  it("providerAuthStatus 抛错 → undefined 而不是让整条开会话链路挂掉", async () => {
    const bridge = {
      providerAuthStatus: vi.fn(async () => {
        throw new Error("main not ready");
      }),
    } as unknown as DesktopBridge;
    await expect(providerConfigFingerprint(bridge, "openai")).resolves.toBeUndefined();
  });
});
