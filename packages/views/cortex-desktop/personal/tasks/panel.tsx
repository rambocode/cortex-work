// todos 面板的懒加载入口。
import { usePanelHost } from "../right-panel/context";
import { TasksView } from "./TasksView";

export default function TodosPanelEntry() {
  const host = usePanelHost();
  return <TasksView onToast={host.toast} />;
}
