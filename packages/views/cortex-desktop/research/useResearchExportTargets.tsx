// 研究产物的去向：把报告送进写作空间或闪记。
//
// **为什么放在 views 的宿主层而不是研究组件里**：ResearchRunView 的既有约定是
// 「组件只负责给内容，去哪儿由宿主决定」（见其 onExportMarkdown 注释）。研究覆盖层不该知道
// 写作空间与闪记的存在——那会把几个工作区耦合成一坨，也让研究组件无法在别的宿主里复用。
//
// 这一层解决的正是「研究是个孤岛」：报告此前唯一的出口是一次浏览器下载，
// 拿到手的 .md 还得自己再拖回应用里。
import { useMemo } from "react";
import { useDesktopBridge, usePersonalStore } from "@cortex-work/core";
import { useAddNote } from "@cortex-work/core/personal/notes";
import { useWritingSpacesStore } from "@cortex-work/core/writing/spaces";
import {
  researchReportFileBaseName,
  withResearchHeader,
} from "@cortex-work/core/research/report-export";

import type { ResearchExportTarget } from "./ResearchRunView";

// 文件名与抬头规则已下沉到 core（主进程归档也用同一份，见 core/research/report-export.ts）。
// 这里保留旧名字原样 re-export，避免调用点与测试跟着改 import 路径。
export { withResearchHeader };
export { researchReportFileBaseName as researchFileBaseName };

/// 组装当前可用的产物去向。
///
/// 每个去向都**按能力存在与否动态增减**：没有写作空间就不给「存为写作文档」，
/// 桥不支持闪记就不给「存为闪记」——给一个点了必然失败的按钮比不给更糟
/// （与研究 MCP 注入的 gate 同一条原则）。
export function useResearchExportTargets(): ResearchExportTarget[] {
  const bridge = useDesktopBridge();
  const addNote = useAddNote();
  const spaces = useWritingSpacesStore((s) => s.spaces);
  const activeSpaceId = useWritingSpacesStore((s) => s.activeSpaceId);
  const openWriting = usePersonalStore((s) => s.openWriting);

  const activeRoot = useMemo(
    () => spaces.find((space) => space.id === activeSpaceId)?.root,
    [spaces, activeSpaceId],
  );

  return useMemo(() => {
    const targets: ResearchExportTarget[] = [];
    const writeFile = bridge?.writeFile;

    // 存为写作文档：写进当前写作空间的根目录，随后切到写作工作区。
    // 只在「有桥、能写文件、且已选定写作空间」时提供。
    if (writeFile && activeRoot) {
      targets.push({
        id: "writing",
        label: "存为写作文档",
        run: async (markdown, session) => {
          const path = `${activeRoot}/${researchReportFileBaseName(session)}.md`;
          await writeFile(path, withResearchHeader(markdown, session));
          // 写完直接切过去：用户点这个按钮的意图就是「拿它去写」，
          // 停在研究覆盖层里还得自己再点两下才能看到成果。
          openWriting();
        },
      });
    }

    // 存为闪记：闪记是「先接住、以后再整理」的收件箱，适合放暂时用不上的研究结论。
    if (typeof bridge?.notesAdd === "function") {
      targets.push({
        id: "note",
        label: "存为闪记",
        run: async (markdown, session) => {
          await addNote.mutateAsync({ content: withResearchHeader(markdown, session) });
        },
      });
    }

    return targets;
  }, [bridge, activeRoot, addNote, openWriting]);
}
