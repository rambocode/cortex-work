// 新会话落地页输入框下方的「项目条」:整个应用里唯一的项目选择入口。
// 会话一旦创建,项目就由会话定死,会话页不再展示项目 / git 信息条(分支、± 统计、
// Commit 都随之下线),所以这里只保留项目选择本身——选具体项目或「不使用项目」。

import { ProjectPicker } from "./ProjectPicker";

export function ProjectBar({
  value,
  onChange,
  onToast,
}: {
  // 当前 projectId;undefined = 不使用项目(新会话默认态)。
  value: string | undefined;
  onChange: (projectId: string | undefined) => void;
  onToast: (text: string) => void;
}) {
  return (
    <div className="pw-project-bar">
      <ProjectPicker
        value={value}
        onChange={onChange}
        allowNoProject
        // value=undefined 时显示「不使用项目」而非「选择项目」占位:新会话默认就是不带项目。
        noProjectChosen
        onToast={onToast}
      />
    </div>
  );
}
