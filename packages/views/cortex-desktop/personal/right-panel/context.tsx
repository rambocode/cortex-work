// PanelHost 软合同:宿主(PersonalRightPanel)向面板注入的共性能力。内部面板不禁止直连
// store,但新面板鼓励只用这份合同——它是未来第三方沙箱面板 API 的种子（届时经
// postMessage 桥出同一语义）。Provider 必须包在 Suspense 外层:fallback 期与面板期
// context 一致,懒加载首帧也取得到。

import { createContext, useContext } from "react";
import type { openPanel } from "./open";

export interface PanelHost {
  /** 当前面板 id（= rightView）。 */
  panelId: string;
  /** 收起右栏面板（setRightOpen(false)）。 */
  close: () => void;
  /** 打开另一个面板（可携带类型化载荷,见 open.ts）。 */
  openPanel: typeof openPanel;
  /** 宿主 toast 通道（原先逐面板透传的 onToast props 收编于此）。 */
  toast: (text: string) => void;
  /** 当前活跃会话 id（无会话为 undefined）。 */
  activeSessionId: string | undefined;
  /** 当前项目路径（无项目会话回退 noProjectDir,再退空串）。 */
  projectPath: string;
}

const PanelHostCtx = createContext<PanelHost | null>(null);

export const PanelHostProvider = PanelHostCtx.Provider;

/** 面板 wrapper 取宿主合同;右栏宿主之外调用是接线错误,直接抛出而非静默降级。 */
export function usePanelHost(): PanelHost {
  const host = useContext(PanelHostCtx);
  if (!host) throw new Error("usePanelHost must be used inside PersonalRightPanel");
  return host;
}
