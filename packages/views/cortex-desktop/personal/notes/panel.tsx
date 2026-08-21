// notes 面板的懒加载入口。
import { usePanelHost } from "../right-panel/context";
import { NotesView } from "./NotesView";

export default function NotesPanelEntry() {
  const host = usePanelHost();
  return <NotesView onToast={host.toast} />;
}
