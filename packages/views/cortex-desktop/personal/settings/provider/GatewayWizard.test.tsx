// 聚合网关接入向导的回归测试。
//
// 守的是方案 §B3/§B4 的四条硬约束（都是从事故里换来的，回归成本极高）：
//   · 能力**零输入**：向导里不得出现任何 contextWindow / maxTokens / 视觉 / 推理 的可写控件；
//   · 探测失败**当场停**：不进入选择步骤、不落盘，绝不出现「保存了一份连不通的 Provider」；
//   · unknown **不可直接启用**：没选参照模型的未识别模型 checkbox 必须禁用（不猜能力红线）；
//   · 刷新**不静默移除**：已启用但网关这次没返回的模型仍在列表里，并带警示。
// 另加一条顺序断言：Key 必须先进金库、再发探测（顺序反了会把 401 误报成不可达）。
//
// 编辑态（`initial`）另有三条同级别的红线，全是「静默破坏用户配置」：
//   · 供应商 id **不随改名漂移**：漂了就等于新存一个 Provider，原来那条沦为孤儿残留；
//   · Secret 名 **不随改名漂移**：漂了就引用到一个金库里不存在的 Secret，运行期 401 且不报错；
//   · 已保存的「参照」来源要原样带回主进程：不带的话能力会被悄悄降级成保守兜底。

import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ReactElement } from "react";
import { CoreProvider, resetProviderCatalogCache } from "@cortex-work/core";
import type { DesktopBridge } from "@cortex-work/core";
import type {
  CustomProviderDefinition,
  GatewayBuildRequest,
  GatewayDiscoverRequest,
  GatewayDiscoveredModel,
} from "@cortex-work/core/desktop/provider-catalog";
import { GatewayWizard } from "./GatewayWizard";

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
      models: [
        { id: "gpt-4o", name: "GPT-4o", api: "openai-responses", input: ["text", "image"], reasoning: true, contextWindow: 272000, maxTokens: 128000 },
      ],
    },
  ],
};

const KNOWN: GatewayDiscoveredModel = {
  id: "gpt-4o",
  status: "known",
  model: { id: "gpt-4o", name: "GPT-4o", api: "openai-completions", input: ["text", "image"], reasoning: true, contextWindow: 272000, maxTokens: 128000 },
  capabilitySource: "openai/gpt-4o",
};
const UNKNOWN: GatewayDiscoveredModel = { id: "gpt-5.6-luna", status: "unknown" };

/**
 * 一条自定义 Provider（能通过 parseCustomProvider 的完整能力字段）。
 * 只为验证它**不会**混进参照候选集——见下面那条测试。
 */
const CUSTOM_DEF: CustomProviderDefinition = {
  id: "my-local",
  json: JSON.stringify({
    name: "本地服务",
    api: "openai-completions",
    baseUrl: "http://localhost:1234/v1",
    models: [
      { id: "local-llm", name: "Local LLM", api: "openai-completions", input: ["text"], reasoning: false, contextWindow: 32000, maxTokens: 4096 },
    ],
  }),
  secretRefs: [],
  updatedAt: 1,
};

/** 编辑态用的原有 Secret 名。刻意与「按当前名称派生」的结果不同，改名测试才有区分力。 */
const SAVED_SECRET = "CUSTOM_GONGSI_WANGGUAN_API_KEY";

/**
 * 一条**向导生成**的已保存定义（三条模型覆盖三种 capabilitySource 形态）。
 * 编辑态的全部断言都建立在它之上：id 与 Secret 名必须原样保住，来源标注必须按形态分流。
 */
const SAVED_GATEWAY: CustomProviderDefinition = {
  id: "gongsi-wangguan",
  json: JSON.stringify({
    name: "公司网关",
    baseUrl: "http://openai.example.cn/v1",
    api: "openai-completions",
    apiKey: `\${secret:${SAVED_SECRET}}`,
    models: [
      {
        id: "gpt-4o",
        name: "GPT-4o",
        api: "openai-completions",
        input: ["text", "image"],
        reasoning: true,
        contextWindow: 272000,
        maxTokens: 128000,
        capabilitySource: "openai/gpt-4o",
      },
      {
        id: "kimi-k2",
        name: "kimi-k2",
        api: "openai-completions",
        input: ["text", "image"],
        reasoning: true,
        contextWindow: 272000,
        maxTokens: 128000,
        capabilitySource: "reference:openai/gpt-4o",
      },
      {
        id: "mystery-1",
        name: "mystery-1",
        api: "openai-completions",
        input: ["text"],
        reasoning: false,
        contextWindow: 128000,
        maxTokens: 16384,
        capabilitySource: "fallback",
      },
    ],
  }),
  secretRefs: [SAVED_SECRET],
  updatedAt: 1,
};

interface Opts {
  discover?: DesktopBridge["providerGatewayDiscover"];
  build?: DesktopBridge["providerGatewayBuild"];
  save?: DesktopBridge["providerCustomSave"];
  customs?: CustomProviderDefinition[];
  /** 记录桥调用顺序**与关键入参**，用来断言「先落金库、再探测」且两处 Secret 名一致。 */
  calls?: string[];
}

function makeBridge(o: Opts = {}): DesktopBridge {
  const calls = o.calls ?? [];
  return {
    providerCatalogGet: vi.fn(async () => ({ ok: true, catalog: CATALOG })),
    providerAuthStatus: vi.fn(async () => ({ statuses: [], health: { available: true }, hiddenProviderIds: [] })),
    providerCustomList: vi.fn(async () => o.customs ?? []),
    providerAuthSetSecrets: vi.fn(async (secrets: Record<string, string>) => {
      calls.push(`secrets:${Object.keys(secrets).join(",")}`);
      return { ok: true };
    }),
    providerGatewayDiscover:
      o.discover ??
      vi.fn(async (req: GatewayDiscoverRequest) => {
        calls.push(`discover:${req.secretName ?? "-"}`);
        return { ok: true, models: [KNOWN, UNKNOWN] };
      }),
    providerGatewayBuild: o.build ?? vi.fn(async () => ({ ok: true, json: '{"name":"公司网关"}' })),
    providerCustomSave: o.save ?? vi.fn(async () => ({ ok: true })),
    onProviderAuthEvent: vi.fn(() => () => undefined),
  } as unknown as DesktopBridge;
}

function renderWizard(
  bridge: DesktopBridge,
  onClose = vi.fn(),
  /** 传入即编辑态（向导反解这份定义后直接进第二步）。 */
  initial?: CustomProviderDefinition,
): { onClose: () => void } {
  const ui: ReactElement = (
    <GatewayWizard storageAvailable initial={initial} onClose={onClose} onSwitchToJson={vi.fn()} />
  );
  render(
    <CoreProvider wsId="ws" identity={{ userId: "me", name: "我" }} desktopBridge={bridge}>
      {ui}
    </CoreProvider>,
  );
  return { onClose };
}

/** 填完第一步并点「连接」。 */
function fillAndConnect(opts: { key?: string } = {}) {
  fireEvent.change(screen.getByPlaceholderText("例:公司网关"), { target: { value: "公司网关" } });
  fireEvent.change(screen.getByPlaceholderText("http://openai.example.cn/v1"), {
    target: { value: "http://openai.example.cn/v1" },
  });
  if (opts.key) {
    fireEvent.change(screen.getByPlaceholderText("网关需要鉴权时填写"), { target: { value: opts.key } });
  }
  fireEvent.click(screen.getByRole("button", { name: "连接" }));
}

/** 拿到某个模型 id 所在的整行容器（行内控件多，断言必须限定作用域）。 */
function rowOf(modelId: string): HTMLElement {
  const el = screen.getByText(modelId).closest(".pw-gw-row");
  if (!el) throw new Error(`row of ${modelId} not found`);
  return el as HTMLElement;
}

afterEach(() => {
  resetProviderCatalogCache();
  cleanup();
});

describe("聚合网关向导", () => {
  it("Key 先进金库、再发探测（顺序反了会把 401 误报成网关不可达）", async () => {
    const calls: string[] = [];
    renderWizard(makeBridge({ calls }));
    fillAndConnect({ key: "sk-test" });
    await screen.findByText("gpt-4o");
    expect(calls).toHaveLength(2);
    // Secret 名由 slug 派生（与预制表单同一条规则 secretNameFor）。
    const written = calls[0]!.slice("secrets:".length);
    expect(written).toMatch(/^CUSTOM_.*_API_KEY$/);
    // 两条断言合起来才是这个用例的价值：discover **在写入之后**发生，且带的是**同一个**
    // Secret 名。名字对不上等于主进程拿不到 Key，网关会回 401——那会被用户读成「地址填错了」。
    expect(calls[1]).toBe(`discover:${written}`);
  });

  it("参照候选只来自随包 Catalog：自定义 Provider 的模型不得入选（能力必须可追溯到受信目录）", async () => {
    renderWizard(makeBridge({ customs: [CUSTOM_DEF] }));
    fillAndConnect();
    await screen.findByText("gpt-5.6-luna");
    fireEvent.click(within(rowOf("gpt-5.6-luna")).getByRole("button", { name: "选参照模型以获得准确能力" }));

    // 随包目录里的条目在候选里（openai 没有任何凭据也照列——这里只借能力元数据，不发请求）。
    expect(await screen.findByRole("option", { name: /GPT-4o/ })).toBeInTheDocument();
    // 自定义 Provider 的模型**不在**：它的能力本身就是用户声明的，拿它当参照会让能力链式
    // 依赖另一份用户输入，「参照 X」就不再可追溯到受信目录，等于把能力红线绕开一层。
    expect(screen.queryByRole("option", { name: /Local LLM/ })).toBeNull();
  });

  it("探测失败 → 当场报错、停在第一步，绝不落盘", async () => {
    const save = vi.fn(async () => ({ ok: true }));
    const discover = vi.fn(async () => ({ ok: false, error: "401 Unauthorized" }));
    renderWizard(makeBridge({ discover, save: save as DesktopBridge["providerCustomSave"] }));
    fillAndConnect({ key: "sk-bad" });
    expect(await screen.findByText(/401 Unauthorized/)).toBeInTheDocument();
    // 仍在第一步：地址输入框还在，没有出现「保存」按钮。
    expect(screen.getByPlaceholderText("http://openai.example.cn/v1")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /启用 .* 个模型并保存/ })).toBeNull();
    expect(save).not.toHaveBeenCalled();
  });

  it("已识别显示目录来源；未识别照样可勾选，并如实说明用的是保守默认", async () => {
    // 「目录不认识」不等于「不能用」——目录只是 pi 的内置快照，不是可用模型的全集。
    // 早先未识别的行是禁用的，导致 new-api 上大量模型（Kimi、各家自研…）根本没法启用。
    renderWizard(makeBridge());
    fillAndConnect();
    await screen.findByText("gpt-4o");

    const known = rowOf("gpt-4o");
    expect(within(known).getByText("图片输入")).toBeInTheDocument();
    expect(within(known).getByText("272K 上下文")).toBeInTheDocument();
    expect(within(known).getByText("能力来源:目录 openai/gpt-4o")).toBeInTheDocument();
    expect(within(known).getByRole("checkbox")).not.toBeDisabled();

    const unknown = rowOf("gpt-5.6-luna");
    expect(within(unknown).getByRole("checkbox")).not.toBeDisabled();
    expect(within(unknown).getByText(/已按保守默认启用/)).toBeInTheDocument();
    // 未识别的行**不摆能力徽标**：把保守默认渲染成徽标会让它看起来像查到的事实。
    expect(within(unknown).queryByText("图片输入")).toBeNull();
  });

  it("未识别模型可直接保存，交给主进程走保守兜底（不再被参照模型卡住）", async () => {
    const build = vi.fn(async (_req: GatewayBuildRequest) => ({ ok: true, json: '{"name":"公司网关"}' }));
    renderWizard(makeBridge({ build: build as DesktopBridge["providerGatewayBuild"] }));
    fillAndConnect();
    await screen.findByText("gpt-5.6-luna");

    fireEvent.click(within(rowOf("gpt-5.6-luna")).getByRole("checkbox"));
    fireEvent.click(screen.getByRole("button", { name: /启用 .* 个模型并保存/ }));

    await waitFor(() => expect(build).toHaveBeenCalled());
    const sent = build.mock.calls[0]![0].models.find((m) => m.id === "gpt-5.6-luna");
    // 没选参照就不带参照字段，能力由主进程兜底并标成 fallback。
    expect(sent).toEqual({ id: "gpt-5.6-luna", referenceProviderId: undefined, referenceModelId: undefined });
  });

  it("能力字段零输入：全程没有任何可写的能力控件（事故根因回归）", async () => {
    renderWizard(makeBridge());
    fillAndConnect();
    await screen.findByText("gpt-4o");
    // 只有「启用」勾选框，没有视觉/推理这类能力 checkbox。
    for (const box of screen.getAllByRole("checkbox")) {
      expect(box.closest(".pw-gw-row")).not.toBeNull();
    }
    expect(screen.queryByText("上下文窗口 (tokens)")).toBeNull();
    expect(screen.queryByText("最大输出 (tokens)")).toBeNull();
    expect(screen.queryByText("支持图片输入")).toBeNull();
    expect(screen.queryByText("支持推理")).toBeNull();
    // 数字输入框一个都不该有。
    expect(document.querySelectorAll('input[inputmode="numeric"]').length).toBe(0);
  });

  it("为未识别模型选参照 → 来源升级为「参照」，保存时把参照引用交给主进程生成 JSON", async () => {
    // 显式标注入参类型：mock.calls 才是有元素的元组，下面要逐字段断言主进程收到的 payload。
    const build = vi.fn(async (_req: GatewayBuildRequest) => ({ ok: true, json: '{"name":"公司网关"}' }));
    const save = vi.fn(async (_def: CustomProviderDefinition) => ({ ok: true }));
    const onClose = vi.fn();
    renderWizard(
      makeBridge({
        build: build as DesktopBridge["providerGatewayBuild"],
        save: save as DesktopBridge["providerCustomSave"],
      }),
      onClose,
    );
    fillAndConnect({ key: "sk-test" });
    await screen.findByText("gpt-5.6-luna");

    fireEvent.click(within(rowOf("gpt-5.6-luna")).getByRole("button", { name: "选参照模型以获得准确能力" }));
    // 参照候选来自**全量** Catalog（不按认证过滤）——这里 openai 没有任何凭据也应列出。
    fireEvent.click(await screen.findByRole("option", { name: /GPT-4o/ }));

    const unknown = rowOf("gpt-5.6-luna");
    expect(within(unknown).getByRole("checkbox")).toBeChecked();
    expect(within(unknown).getByText("能力来源:参照 OpenAI/gpt-4o")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: /启用 1 个模型并保存/ }));
    await waitFor(() => expect(build).toHaveBeenCalled());
    expect(build.mock.calls[0]![0]).toMatchObject({
      name: "公司网关",
      baseUrl: "http://openai.example.cn/v1",
      api: "openai-completions",
      models: [{ id: "gpt-5.6-luna", referenceProviderId: "openai", referenceModelId: "gpt-4o" }],
    });
    await waitFor(() => expect(save).toHaveBeenCalled());
    // 主进程生成的 JSON 原样落盘，且带上 Secret 引用（渲染端不改一个字节）。
    expect(save.mock.calls[0]![0]).toMatchObject({ json: '{"name":"公司网关"}' });
    expect(save.mock.calls[0]![0].secretRefs).toHaveLength(1);
    await waitFor(() => expect(onClose).toHaveBeenCalled());
  });

  it("刷新：网关新增的模型追加为候选，已启用但这次没返回的仍在列表里并标警示", async () => {
    const discover = vi
      .fn()
      .mockResolvedValueOnce({ ok: true, models: [KNOWN, UNKNOWN] })
      // 第二次：gpt-4o 消失、多出一条 new-model。
      .mockResolvedValueOnce({
        ok: true,
        models: [UNKNOWN, { id: "new-model", status: "known", model: KNOWN.model, capabilitySource: "openai/gpt-4o" }],
      });
    renderWizard(makeBridge({ discover: discover as DesktopBridge["providerGatewayDiscover"] }));
    fillAndConnect();
    await screen.findByText("gpt-4o");
    fireEvent.click(within(rowOf("gpt-4o")).getByRole("checkbox"));

    fireEvent.click(screen.getByRole("button", { name: "刷新模型列表" }));
    // 新增的追加为候选
    expect(await screen.findByText("new-model")).toBeInTheDocument();
    // 已启用的 gpt-4o 没有被静默移除，且带上警示
    expect(screen.getByText("gpt-4o")).toBeInTheDocument();
    expect(within(rowOf("gpt-4o")).getByText(/最近一次刷新时网关没有返回这个模型/)).toBeInTheDocument();
    expect(screen.getByText(/以下已启用的模型在最近一次刷新中没有出现/)).toBeInTheDocument();
  });

  it("编辑态：直接进第二步，已保存模型全部预勾选，且**不需要先联网**", async () => {
    const discover = vi.fn(async () => ({ ok: true, models: [KNOWN, UNKNOWN] }));
    renderWizard(
      makeBridge({ discover: discover as unknown as DesktopBridge["providerGatewayDiscover"] }),
      vi.fn(),
      SAVED_GATEWAY,
    );

    // 网关临时不可达也要能改配置，所以打开编辑器**不许**发探测。
    expect(discover).not.toHaveBeenCalled();
    expect(await screen.findByText("mystery-1")).toBeInTheDocument();
    for (const id of ["gpt-4o", "kimi-k2", "mystery-1"]) {
      expect(within(rowOf(id)).getByRole("checkbox")).toBeChecked();
    }
    expect(screen.getByRole("button", { name: "启用 3 个模型并保存" })).toBeInTheDocument();
    // fallback 来源的行按「未识别」渲染：那几个数字是保守默认，摆成徽标会让它看起来像事实。
    expect(within(rowOf("mystery-1")).getByText(/已按保守默认启用/)).toBeInTheDocument();
    expect(within(rowOf("mystery-1")).queryByText(/上下文/)).toBeNull();
  });

  it("编辑态：capabilitySource 为 reference:… 的行显示「参照」，不是「目录」", async () => {
    renderWizard(makeBridge(), vi.fn(), SAVED_GATEWAY);
    await screen.findByText("kimi-k2");
    const row = rowOf("kimi-k2");
    // 参照是**用户当初做的判断**，标成「目录」等于把它说成系统查到的事实。
    expect(within(row).getByText("能力来源:参照 openai/gpt-4o")).toBeInTheDocument();
    expect(within(row).queryByText(/能力来源:目录/)).toBeNull();
    // 目录命中的行仍然显示「目录」。
    expect(within(rowOf("gpt-4o")).getByText("能力来源:目录 openai/gpt-4o")).toBeInTheDocument();
  });

  it("编辑态：不重填 Key 也能保存，沿用金库里已有的 Secret", async () => {
    const build = vi.fn(async (_req: GatewayBuildRequest) => ({ ok: true, json: '{"name":"公司网关"}' }));
    const save = vi.fn(async (_def: CustomProviderDefinition) => ({ ok: true }));
    const onClose = vi.fn();
    renderWizard(
      makeBridge({
        build: build as DesktopBridge["providerGatewayBuild"],
        save: save as DesktopBridge["providerCustomSave"],
      }),
      onClose,
      SAVED_GATEWAY,
    );
    await screen.findByText("gpt-4o");
    fireEvent.click(screen.getByRole("button", { name: "启用 3 个模型并保存" }));

    await waitFor(() => expect(build).toHaveBeenCalled());
    expect(build.mock.calls[0]![0].secretName).toBe(SAVED_SECRET);
    // 已保存的「参照」来源必须原样带回主进程：不带的话目录照样认不出 kimi-k2，
    // 主进程会退回保守兜底 —— 用户什么都没改，能力却被悄悄改小了。
    expect(build.mock.calls[0]![0].models).toContainEqual({
      id: "kimi-k2",
      referenceProviderId: "openai",
      referenceModelId: "gpt-4o",
    });
    await waitFor(() => expect(save).toHaveBeenCalled());
    expect(save.mock.calls[0]![0].secretRefs).toEqual([SAVED_SECRET]);
    await waitFor(() => expect(onClose).toHaveBeenCalled());
  });

  it("编辑态改名：id 与 Secret 名都不跟着漂移（防孤儿化 / 防引用到不存在的 Secret）", async () => {
    const build = vi.fn(async (_req: GatewayBuildRequest) => ({ ok: true, json: '{"name":"新名字"}' }));
    const save = vi.fn(async (_def: CustomProviderDefinition) => ({ ok: true }));
    renderWizard(
      makeBridge({
        build: build as DesktopBridge["providerGatewayBuild"],
        save: save as DesktopBridge["providerCustomSave"],
      }),
      vi.fn(),
      SAVED_GATEWAY,
    );
    await screen.findByText("gpt-4o");

    // 回第一步改名 → 重新连接 → 保存。
    fireEvent.click(screen.getByRole("button", { name: "返回修改" }));
    fireEvent.change(screen.getByPlaceholderText("例:公司网关"), { target: { value: "新名字" } });
    fireEvent.click(screen.getByRole("button", { name: "连接" }));
    await screen.findByText("gpt-5.6-luna");
    fireEvent.click(screen.getByRole("button", { name: /启用 .* 个模型并保存/ }));

    await waitFor(() => expect(build).toHaveBeenCalled());
    // 新建态下 id = slugifyProviderId(name)，「新名字」会 slug 成 custom-provider —— 那正是
    // 事故形态：保存出一个**新**供应商，原来那条变成谁也管不着的孤儿。
    expect(build.mock.calls[0]![0].id).toBe(SAVED_GATEWAY.id);
    expect(build.mock.calls[0]![0].name).toBe("新名字");
    // Secret 名同理由名称派生，漂移后会引用到一个金库里根本不存在的 Secret（运行期 401，且不报错）。
    expect(build.mock.calls[0]![0].secretName).toBe(SAVED_SECRET);

    await waitFor(() => expect(save).toHaveBeenCalled());
    expect(save.mock.calls[0]![0].id).toBe(SAVED_GATEWAY.id);
    expect(save.mock.calls[0]![0].secretRefs).toEqual([SAVED_SECRET]);
  });

  it("编辑态重新连接：网关这次没返回的已保存模型不被静默移除", async () => {
    // 默认 discover 只返回 gpt-4o / gpt-5.6-luna，已保存的 kimi-k2 与 mystery-1 都不在其中。
    renderWizard(makeBridge(), vi.fn(), SAVED_GATEWAY);
    await screen.findByText("kimi-k2");
    fireEvent.click(screen.getByRole("button", { name: "返回修改" }));
    fireEvent.click(screen.getByRole("button", { name: "连接" }));

    await screen.findByText("gpt-5.6-luna");
    expect(screen.getByText("kimi-k2")).toBeInTheDocument();
    expect(within(rowOf("kimi-k2")).getByText(/最近一次刷新时网关没有返回这个模型/)).toBeInTheDocument();
  });

  it("桥不支持（Web 端 / 旧壳）→ 降级提示，不白屏", async () => {
    const bridge = makeBridge();
    delete (bridge as { providerGatewayDiscover?: unknown }).providerGatewayDiscover;
    renderWizard(bridge);
    expect(await screen.findByText(/当前环境不支持聚合网关接入/)).toBeInTheDocument();
  });
});
