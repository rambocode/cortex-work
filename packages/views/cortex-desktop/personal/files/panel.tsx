// files 面板的懒加载入口:经 PanelHost 适配 FilesView（onToast 收编进宿主合同）。
import { usePanelHost } from "../right-panel/context";
import { FilesView } from "./FilesView";

export default function FilesPanelEntry() {
  const host = usePanelHost();
  return <FilesView onToast={host.toast} />;
}
