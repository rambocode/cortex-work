"use client";

import { CoreProvider } from "@cortex-work/core";
import { CortexDesktopView } from "@cortex-work/views/cortex-desktop";

export default function Page() {
  const apiUrl = process.env.NEXT_PUBLIC_CORTEX_API_URL ?? process.env.NEXT_PUBLIC_API_URL;
  const token = process.env.NEXT_PUBLIC_CORTEX_AUTH_TOKEN;
  const workspaceId = process.env.NEXT_PUBLIC_CORTEX_WORKSPACE_ID ?? "demo-workspace";
  const workspaceSlug = process.env.NEXT_PUBLIC_CORTEX_WORKSPACE_SLUG;

  return (
    <CoreProvider
      wsId={workspaceId}
      identity={{ userId: "me", name: "我" }}
      apiConfig={{
        enabled: !!apiUrl && (!!workspaceId || !!workspaceSlug),
        baseUrl: apiUrl,
        token,
        workspaceId,
        workspaceSlug,
        platform: "web",
      }}
    >
      <CortexDesktopView />
    </CoreProvider>
  );
}
