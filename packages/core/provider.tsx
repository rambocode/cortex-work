// CoreProvider — the single initialization entry point. The host shell (web or
// desktop) injects identity + workspace id; this builds the QueryClient and
// exposes the workspace id via context so query hooks namespace their keys.

import { createContext, useContext, useMemo, useState, type ReactNode } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createQueryClient } from "./query-client";
import { ApiClient, type ApiClientConfig } from "./api/client";
import type { DesktopBridge } from "./desktop/bridge";

export interface Identity {
  userId: string;
  name: string;
}

export interface CoreContextValue {
  wsId: string;
  identity: Identity;
  apiClient: ApiClient | null;
  liveDataEnabled: boolean;
  // 桌面端能力桥（个人工作区）。web 端为 null。
  desktopBridge: DesktopBridge | null;
  // 用户主目录绝对路径(桌面壳经 appInfo 注入)。core 不读 os/env,目录授权合成
  // generated-images 路径(~/.codex/generated_images)需经此注入。web 端 undefined。
  home?: string;
}

const CoreContext = createContext<CoreContextValue | null>(null);

export interface CoreProviderProps {
  wsId: string;
  identity: Identity;
  apiConfig?: (Partial<ApiClientConfig> & { enabled?: boolean }) | null;
  queryClient?: QueryClient;
  desktopBridge?: DesktopBridge | null;
  home?: string;
  children: ReactNode;
}

export function CoreProvider({ wsId, identity, apiConfig, queryClient, desktopBridge, home, children }: CoreProviderProps) {
  const [client] = useState(() => queryClient ?? createQueryClient());
  const apiClient = useMemo(() => {
    if (!apiConfig?.enabled || !apiConfig.baseUrl) return null;
    return new ApiClient({
      baseUrl: apiConfig.baseUrl,
      token: apiConfig.token,
      workspaceId: apiConfig.workspaceId ?? wsId,
      workspaceSlug: apiConfig.workspaceSlug,
      platform: apiConfig.platform,
      version: apiConfig.version,
      os: apiConfig.os,
    });
  }, [
    apiConfig?.baseUrl,
    apiConfig?.enabled,
    apiConfig?.os,
    apiConfig?.platform,
    apiConfig?.token,
    apiConfig?.version,
    apiConfig?.workspaceId,
    apiConfig?.workspaceSlug,
    wsId,
  ]);
  return (
    <CoreContext.Provider
      value={{ wsId, identity, apiClient, liveDataEnabled: !!apiClient, desktopBridge: desktopBridge ?? null, home }}
    >
      <QueryClientProvider client={client}>{children}</QueryClientProvider>
    </CoreContext.Provider>
  );
}

// 个人工作区的桌面能力入口。返回 null 即当前宿主（web）不支持。
export function useDesktopBridge(): DesktopBridge | null {
  return useCoreContext().desktopBridge;
}

// 用户主目录(桌面壳注入)。web 端 / 旧壳为 undefined,调用方需兜底。
export function useHome(): string | undefined {
  return useCoreContext().home;
}

export function useCoreContext(): CoreContextValue {
  const ctx = useContext(CoreContext);
  if (!ctx) throw new Error("useCoreContext must be used within a CoreProvider");
  return ctx;
}

export function useWorkspaceId(): string {
  return useCoreContext().wsId;
}
