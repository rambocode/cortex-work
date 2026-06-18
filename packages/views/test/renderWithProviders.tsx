import { render, type RenderResult } from "@testing-library/react";
import { CoreProvider } from "@cortex-work/core";
import type { DesktopBridge, Identity } from "@cortex-work/core";
import type { ReactElement } from "react";

// 共享渲染助手:把组件包进 CoreProvider(注入默认 identity / wsId / bridge)。
// i18n 由 test/setup.ts 同步灌入,组件 t() 首渲染即解析为 zh 值。供提取单元的组件测试复用。
export function renderWithProviders(
  ui: ReactElement,
  opts: { bridge?: DesktopBridge | null; identity?: Identity; wsId?: string } = {},
): RenderResult {
  const { bridge = null, identity = { userId: "me", name: "我" }, wsId = "test-ws" } = opts;
  return render(
    <CoreProvider wsId={wsId} identity={identity} desktopBridge={bridge}>
      {ui}
    </CoreProvider>,
  );
}
