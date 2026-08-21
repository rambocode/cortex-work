// browser 面板的懒加载入口。
import { usePanelHost } from "../right-panel/context";
import { BrowserView } from "./BrowserView";

export default function BrowserPanelEntry() {
  const host = usePanelHost();
  return <BrowserView onToast={host.toast} />;
}
