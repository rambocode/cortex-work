// Composer 上方 git 信息条:项目名 · 分支 + 工作区 ± 统计徽章(点击 → 右栏整仓
// diff)+ Commit changes 按钮(直接向当前 session 发送提交指令)。
// 非 git 仓库(或无 gitInfo 能力)整条隐藏;工作区干净只显示分支。

import { useEffect, useRef } from "react";
import { Icon } from "@cortex-work/ui/icons";
import {
  useCortexUIStore,
  useInvalidateGitInfo,
  usePersonalStore,
  useProjectGitInfo,
} from "@cortex-work/core";
import type { ProjectMeta } from "@cortex-work/core";

export const COMMIT_PROMPT = "Commit the working tree changes with a sensible message.";

export function GitBar({
  project,
  running,
  onSend,
  onToast,
}: {
  project: ProjectMeta;
  running: boolean;
  onSend: (text: string) => void;
  onToast: (text: string) => void;
}) {
  const info = useProjectGitInfo(project.path);
  const requestGitDiff = usePersonalStore((s) => s.requestGitDiff);
  const setRightOpen = useCortexUIStore((s) => s.setRightOpen);
  const invalidate = useInvalidateGitInfo();

  // run 结束边沿(true→false)立即刷新统计:agent 完成 commit 后徽章应尽快消失,
  // 不等下一轮 5s 轮询。
  const prevRunning = useRef(running);
  useEffect(() => {
    if (prevRunning.current && !running) invalidate(project.path);
    prevRunning.current = running;
  }, [running, project.path, invalidate]);

  if (!info?.isRepo || !info.branch) return null;

  return (
    <div className="pw-gitbar">
      <div className="pw-gitbar-left">
        <span className="pw-gitbar-name">{project.name}</span>
        <span className="pw-gitbar-branch">
          <Icon.GitBranch size={12} />
          {info.branch}
        </span>
      </div>
      {info.dirty ? (
        <div className="pw-gitbar-right">
          <button
            type="button"
            className="pw-gitbar-stats"
            title="查看 diff"
            onClick={() => {
              setRightOpen(true);
              requestGitDiff(project.id);
            }}
          >
            <span className="pw-gitbar-add">+{info.additions.toLocaleString()}</span>
            <span className="pw-gitbar-del">−{info.deletions.toLocaleString()}</span>
            {info.truncated ? <span className="pw-gitbar-approx">≈</span> : null}
          </button>
          <button
            type="button"
            className="pw-gitbar-commit"
            disabled={running}
            onClick={() => {
              onSend(COMMIT_PROMPT);
              onToast("已发送提交指令");
            }}
          >
            Commit changes
          </button>
        </div>
      ) : null}
    </div>
  );
}
