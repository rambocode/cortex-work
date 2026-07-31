// Provider 管理页与全局模型选择器共用的数据层：Catalog（只读能力）+ 认证状态 + 自定义 Provider。
//
// 三份数据的职责边界（不要混）：
//   · Catalog        —— 构建期从 pi 内置目录生成，**只读**，含全部能力元数据。随包不变 → staleTime ∞。
//   · AuthSnapshot   —— 每个 Provider 的 configured/type/source + 密钥库健康度 + 用户隐藏偏好。
//                       只有布尔与枚举，**永远不含明文/密文**（见 provider-catalog.ts 红线 2）。
//   · CustomProvider —— 用户粘贴的完整 Pi Provider JSON。Cortex 不拆字段、不补默认值。
//
// 全部桥方法都是可选的（Web 端为 null、旧壳缺方法），故每个 hook 都带 `unsupported` 出口，
// 调用方必须渲染降级态而不是白屏。

import { useCallback } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useDesktopBridge, useProviderCatalog } from "@cortex-work/core";
import type {
  CatalogModel,
  CatalogProvider,
  CustomProviderDefinition,
  ModelRef,
  ProviderAuthSnapshot,
  ProviderAuthStatus,
} from "@cortex-work/core/desktop/provider-catalog";

export const providerAuthKey = ["personal", "providerAuth"] as const;
export const providerCustomKey = ["personal", "providerCustom"] as const;

const EMPTY_SNAPSHOT: ProviderAuthSnapshot = {
  statuses: [],
  health: { available: true },
  hiddenProviderIds: [],
};

/** 认证状态订阅。OAuth 事件流结束后由 `invalidateProviderAuth` 主动失效，故不轮询。 */
export function useProviderAuth(): {
  snapshot: ProviderAuthSnapshot;
  loading: boolean;
  unsupported: boolean;
  refetch: () => void;
} {
  const bridge = useDesktopBridge();
  const supported = !!bridge?.providerAuthStatus;
  const q = useQuery({
    queryKey: providerAuthKey,
    queryFn: async () => (await bridge!.providerAuthStatus!()) ?? EMPTY_SNAPSHOT,
    enabled: supported,
    staleTime: 5_000,
    retry: false,
  });
  return {
    snapshot: q.data ?? EMPTY_SNAPSHOT,
    loading: supported && q.isLoading,
    unsupported: !supported,
    refetch: () => void q.refetch(),
  };
}

/** 自定义 Provider 列表。保存/删除后由各 mutation 失效。 */
export function useCustomProviders(): {
  items: CustomProviderDefinition[];
  loading: boolean;
  unsupported: boolean;
} {
  const bridge = useDesktopBridge();
  const supported = !!bridge?.providerCustomList;
  const q = useQuery({
    queryKey: providerCustomKey,
    queryFn: async () => (await bridge!.providerCustomList!()) ?? [],
    enabled: supported,
    staleTime: 5_000,
    retry: false,
  });
  return { items: q.data ?? [], loading: supported && q.isLoading, unsupported: !supported };
}

/** 认证类写操作。每个都在成功后失效 auth 快照——状态是主进程的真相，不在渲染端乐观更新。 */
export function useProviderAuthActions() {
  const bridge = useDesktopBridge();
  const qc = useQueryClient();
  const invalidate = useCallback(() => {
    void qc.invalidateQueries({ queryKey: providerAuthKey });
  }, [qc]);

  const setApiKey = useMutation({
    mutationFn: async (v: { providerId: string; apiKey: string }) =>
      (await bridge?.providerAuthSetApiKey?.(v.providerId, v.apiKey)) ?? { ok: false, error: "unsupported" },
    onSuccess: invalidate,
  });
  const logout = useMutation({
    mutationFn: async (providerId: string) =>
      (await bridge?.providerAuthLogout?.(providerId)) ?? { ok: false, error: "unsupported" },
    onSuccess: invalidate,
  });
  const setHidden = useMutation({
    mutationFn: async (ids: string[]) =>
      (await bridge?.providerAuthSetHidden?.(ids)) ?? { ok: false, error: "unsupported" },
    // 隐藏偏好落在 main-owned 的 provider-prefs.json（不进 PersistedState 白名单），
    // 故渲染端无需镜像，只失效快照重读即可。
    onSuccess: invalidate,
  });
  // baseUrl 覆盖：传 undefined 清除覆盖、恢复 Catalog 里的内置端点。
  // 落在 main-owned 的 provider-prefs.json（不进 PersistedState 白名单），故只失效快照重读。
  const setBaseUrl = useMutation({
    mutationFn: async (v: { providerId: string; baseUrl: string | undefined }) =>
      (await bridge?.providerAuthSetBaseUrl?.(v.providerId, v.baseUrl)) ?? { ok: false, error: "unsupported" },
    onSuccess: invalidate,
  });
  const setSecrets = useMutation({
    mutationFn: async (secrets: Record<string, string>) =>
      (await bridge?.providerAuthSetSecrets?.(secrets)) ?? { ok: false, error: "unsupported" },
    onSuccess: invalidate,
  });

  return { setApiKey, logout, setHidden, setSecrets, setBaseUrl, invalidate };
}

/** 自定义 Provider 写操作。 */
export function useCustomProviderActions() {
  const bridge = useDesktopBridge();
  const qc = useQueryClient();
  const invalidate = useCallback(() => {
    void qc.invalidateQueries({ queryKey: providerCustomKey });
  }, [qc]);

  const save = useMutation({
    mutationFn: async (def: CustomProviderDefinition) =>
      (await bridge?.providerCustomSave?.(def)) ?? { ok: false, error: "unsupported" },
    onSuccess: invalidate,
  });
  const remove = useMutation({
    mutationFn: async (id: string) =>
      (await bridge?.providerCustomDelete?.(id)) ?? { ok: false, error: "unsupported" },
    onSuccess: invalidate,
  });
  return { save, remove };
}

/**
 * 把一条自定义 Provider 的 JSON 解析成 Catalog 形状，供模型选择器与只读能力列表统一消费。
 *
 * 刻意**不补任何默认值**：`input` / `reasoning` / `contextWindow` / `maxTokens` 缺失就整条模型
 * 丢弃（返回的 models 里没有它）。研究文档 §5.1 的硬要求——「目录不知道」绝不能被写成
 * `input:["text"]`，那正是事故根因；宁可让模型不出现在选择器里，也不能给出错误能力。
 * 解析失败返回 undefined，调用方按「该自定义 Provider 配置不完整」展示。
 */
export function parseCustomProvider(def: CustomProviderDefinition): CatalogProvider | undefined {
  let raw: unknown;
  try {
    raw = JSON.parse(def.json);
  } catch {
    return undefined;
  }
  if (!raw || typeof raw !== "object") return undefined;
  const o = raw as Record<string, unknown>;
  const models: CatalogModel[] = [];
  for (const m of Array.isArray(o.models) ? o.models : []) {
    if (!m || typeof m !== "object") continue;
    const mm = m as Record<string, unknown>;
    const id = typeof mm.id === "string" ? mm.id : "";
    const input = Array.isArray(mm.input) ? mm.input.filter((x): x is "text" | "image" => x === "text" || x === "image") : [];
    // 四个能力字段缺一不可 —— 缺了就是配置不完整，不猜。
    if (!id || input.length === 0) continue;
    if (typeof mm.reasoning !== "boolean") continue;
    if (typeof mm.contextWindow !== "number" || typeof mm.maxTokens !== "number") continue;
    models.push({
      id,
      name: typeof mm.name === "string" ? mm.name : id,
      api: typeof mm.api === "string" ? mm.api : typeof o.api === "string" ? o.api : "",
      input,
      reasoning: mm.reasoning,
      thinkingLevelMap: (mm.thinkingLevelMap as Record<string, string> | undefined) ?? undefined,
      contextWindow: mm.contextWindow,
      maxTokens: mm.maxTokens,
      cost: (mm.cost as CatalogModel["cost"]) ?? undefined,
      compat: mm.compat,
    });
  }
  return {
    id: def.id,
    name: typeof o.name === "string" ? o.name : def.id,
    api: typeof o.api === "string" ? o.api : "",
    baseUrl: typeof o.baseUrl === "string" ? o.baseUrl : undefined,
    auth: [],
    models,
  };
}

/** 一个 Provider 在 UI 里的合并视图：目录条目 + 认证状态 + 隐藏偏好 + 是否自定义。 */
export interface ProviderView {
  provider: CatalogProvider;
  status: ProviderAuthStatus;
  hidden: boolean;
  custom: boolean;
}

const NO_AUTH: Omit<ProviderAuthStatus, "providerId"> = { configured: false, source: "none" };

/**
 * 合并三份数据出 Provider 视图列表（内建在前、自定义在后，各自按名称排序）。
 * 无认证方式的 Provider（`auth: []`，如本地端点）视为**天然可用**——它压根不需要凭据，
 * 若按 `configured` 判定会被错误地排除出模型选择器。
 */
export function useProviderViews(): {
  views: ProviderView[];
  loading: boolean;
  catalogError: string | undefined;
  catalogUnsupported: boolean;
  snapshot: ProviderAuthSnapshot;
} {
  const { catalog, error, loading: catalogLoading, unsupported } = useProviderCatalog();
  const { snapshot, loading: authLoading } = useProviderAuth();
  const { items } = useCustomProviders();

  const statusById = new Map(snapshot.statuses.map((s) => [s.providerId, s]));
  const hidden = new Set(snapshot.hiddenProviderIds);
  const build = (p: CatalogProvider, custom: boolean): ProviderView => ({
    provider: p,
    status: statusById.get(p.id) ?? { providerId: p.id, ...NO_AUTH },
    hidden: hidden.has(p.id),
    custom,
  });

  const builtin = (catalog?.providers ?? []).map((p) => build(p, false));
  const customs = items
    .map(parseCustomProvider)
    .filter((p): p is CatalogProvider => !!p)
    .map((p) => build(p, true));
  const byName = (a: ProviderView, b: ProviderView) => a.provider.name.localeCompare(b.provider.name);

  return {
    views: [...builtin.sort(byName), ...customs.sort(byName)],
    loading: catalogLoading || authLoading,
    catalogError: error,
    catalogUnsupported: unsupported,
    snapshot,
  };
}

/** 该 Provider 是否「可用」：无需认证，或已配置凭据。 */
export function providerUsable(v: ProviderView): boolean {
  return v.provider.auth.length === 0 || v.status.configured;
}

/** 该来源的凭据是否由 Cortex 保管（= 可删除）。env / ambient 由宿主环境提供，只能读。 */
export function credentialDeletable(status: ProviderAuthStatus): boolean {
  return status.configured && status.source === "safe-storage";
}

/** 模型选择器可选项：一个模型 + 它所属 Provider 的展示信息。 */
export interface ModelOption extends ModelRef {
  providerName: string;
  model: CatalogModel;
}

/**
 * 模型选择器的候选集：**认证可用 ∧ 用户未隐藏** 的 Provider 的全部模型。
 * `requireImage` 时只留 `input` 含 image 的（Computer Use 必须看得见屏幕，见计划 §4.2）。
 */
export function collectModelOptions(views: ProviderView[], requireImage = false): ModelOption[] {
  const out: ModelOption[] = [];
  for (const v of views) {
    if (v.hidden || !providerUsable(v)) continue;
    for (const m of v.provider.models) {
      if (requireImage && !m.input.includes("image")) continue;
      out.push({ providerId: v.provider.id, modelId: m.id, providerName: v.provider.name, model: m });
    }
  }
  return out;
}

/** 搜索过滤：Provider 名 / 模型 id / 模型名，大小写不敏感，空串放行全部。 */
export function filterModelOptions(options: ModelOption[], query: string): ModelOption[] {
  const q = query.trim().toLowerCase();
  if (!q) return options;
  return options.filter(
    (o) =>
      o.providerName.toLowerCase().includes(q) ||
      o.modelId.toLowerCase().includes(q) ||
      o.model.name.toLowerCase().includes(q),
  );
}
