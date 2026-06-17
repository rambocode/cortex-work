// Composer 上方「项目 · 分支」信息条,两种用法:
// - 会话页(只读项目):不传 onChangeProject → 项目名只读(会话已绑定,不在此切换);
//   传 onSend → 显示 ± 统计徽章(点击 → 右栏整仓 diff)+ Commit changes 按钮。
// - 新会话页(可切项目):传 onChangeProject → 项目可切 / 不使用项目;不传 onSend → 无 Commit。
// 分支段(可点下拉:列 / 切 / 新建分支)对有 git 仓库的项目始终显示;切分支遇未提交改动 =
// 禁止并提示先提交。无真实项目只显示「无项目」。

import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { Icon } from "@cortex-work/ui/icons";
import {
  useCortexUIStore,
  useGitBranchActions,
  useInvalidateGitInfo,
  usePersonalStore,
  useProjectBranches,
  useProjectGitInfo,
} from "@cortex-work/core";
import type { ProjectMeta } from "@cortex-work/core";
import { ProjectPicker } from "./ProjectPicker";

export const COMMIT_PROMPT = "Commit the working tree changes with a sensible message.";

export function GitBar({
  project,
  projectValue,
  noProjectChosen,
  onChangeProject,
  running,
  onSend,
  onToast,
}: {
  // 真实项目（git 查询用）;不使用项目 / 未选项目时为 undefined,此时只显示项目选择器。
  project: ProjectMeta | undefined;
  // 当前 projectId（ProjectPicker 据此显示项目名;undefined = 不使用项目）。
  projectValue: string | undefined;
  // projectValue=undefined 时:true → 选择器显示「不使用项目」,false → 显示「选择项目」占位。
  noProjectChosen?: boolean;
  // 提供 = 项目可切换（新会话页）;不提供 = 只读项目名（会话页）。
  onChangeProject?: (id: string | undefined) => void;
  running: boolean;
  // 提供 = 显示 ± 统计 + Commit（会话页有 session）;不提供 = 不显示（新会话页无 session）。
  onSend?: (text: string) => void;
  onToast: (text: string) => void;
}) {
  const info = useProjectGitInfo(project?.path);
  const branchInfo = useProjectBranches(project?.path);
  const { createBranch, checkout } = useGitBranchActions();
  const requestGitDiff = usePersonalStore((s) => s.requestGitDiff);
  const setRightOpen = useCortexUIStore((s) => s.setRightOpen);
  const invalidate = useInvalidateGitInfo();

  // 分支下拉菜单(fixed 定位 + 点击外部/Esc 关闭,交互仿 ProjectMenu)。
  const triggerRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState({ left: 0, top: 0 });
  // 新建分支:点开后显示输入框,提交即创建并切换。
  const [creating, setCreating] = useState(false);
  const [newName, setNewName] = useState("");

  const close = () => {
    setOpen(false);
    setCreating(false);
    setNewName("");
  };

  // run 结束边沿(true→false)立即刷新统计:agent 完成 commit 后徽章应尽快消失,
  // 不等下一轮 5s 轮询。
  const prevRunning = useRef(running);
  useEffect(() => {
    if (prevRunning.current && !running && project) invalidate(project.path);
    prevRunning.current = running;
  }, [running, project, invalidate]);

  // 打开下拉时按触发器位置定位(fixed,向上弹出:gitbar 贴近底部 composer),并据视口收敛。
  useLayoutEffect(() => {
    if (!open) return;
    const anchor = triggerRef.current?.getBoundingClientRect();
    if (!anchor) return;
    const panel = panelRef.current?.getBoundingClientRect();
    const width = panel?.width ?? 220;
    const height = panel?.height ?? 240;
    const left = Math.max(8, Math.min(anchor.left, window.innerWidth - width - 8));
    // 优先向上弹(触发器上方),空间不足再向下。
    const top = anchor.top - height - 4 >= 8 ? anchor.top - height - 4 : anchor.bottom + 4;
    setPos({ left, top: Math.max(8, Math.min(top, window.innerHeight - height - 8)) });
  }, [open, branchInfo?.branches.length, creating]);

  // 点击外部 / Esc / 窗口失焦:关闭并复位新建态。
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      const t = e.target as Node;
      if (panelRef.current?.contains(t) || triggerRef.current?.contains(t)) return;
      close();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") close();
    };
    const onBlur = () => close();
    window.addEventListener("mousedown", onDown, true);
    window.addEventListener("keydown", onKey);
    window.addEventListener("blur", onBlur);
    return () => {
      window.removeEventListener("mousedown", onDown, true);
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("blur", onBlur);
    };
  }, [open]);

  // 是否展示分支段:有真实项目且是 git 仓库。无项目会话只剩项目选择器。
  const hasGit = !!project && !!info?.isRepo && !!info.branch;
  const branches = branchInfo?.branches ?? [];
  const currentBranch = branchInfo?.current ?? info?.branch ?? "";
  // detached HEAD:current 是 SHA、不在 branches 列表内 → 禁用切换(无法可靠定位当前分支)。
  const detached = branches.length > 0 && !branches.includes(currentBranch);

  const handleCheckout = (name: string) => {
    if (!project) return;
    void (async () => {
      if (name === currentBranch) {
        close();
        return;
      }
      // 工作区有未提交改动:禁止切换,提示先提交。
      if (info?.dirty) {
        onToast("工作区有未提交改动，请先提交后再切换分支");
        return;
      }
      const res = await checkout(project.path, name);
      if (!res.ok) {
        onToast(res.message ?? "切换分支失败");
        return;
      }
      onToast(`已切换到 ${name}`);
      invalidate(project.path);
      close();
    })();
  };

  const handleCreate = () => {
    if (!project) return;
    const name = newName.trim();
    if (!name) return;
    void (async () => {
      const res = await createBranch(project.path, name);
      if (!res.ok) {
        onToast(res.message ?? "新建分支失败");
        return;
      }
      onToast(`已创建并切换到 ${name}`);
      invalidate(project.path);
      close();
    })();
  };

  return (
    <div className="pw-gitbar">
      <div className="pw-gitbar-left">
        <ProjectPicker
          value={projectValue}
          onChange={onChangeProject ?? (() => {})}
          allowNoProject
          noProjectChosen={noProjectChosen}
          readOnly={!onChangeProject}
          disabled={running}
          onToast={onToast}
        />
        {hasGit ? (
          <button
            ref={triggerRef}
            type="button"
            className="pw-gitbar-branch is-clickable"
            data-open={open}
            onClick={() => setOpen((v) => !v)}
            title="切换 / 新建分支"
            aria-haspopup="menu"
            aria-expanded={open}
          >
            <Icon.GitBranch size={12} />
            {currentBranch}
            <Icon.Chevron size={11} className="chev" />
          </button>
        ) : null}
      </div>
      {onSend && hasGit && info.dirty ? (
        <div className="pw-gitbar-right">
          <button
            type="button"
            className="pw-gitbar-stats"
            title="查看 diff"
            onClick={() => {
              if (!project) return;
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

      {open && hasGit ? (
        <div
          ref={panelRef}
          className="pw-proj-picker-panel"
          style={{ position: "fixed", left: pos.left, top: pos.top }}
          role="menu"
          aria-label="切换分支"
        >
          <div className="pw-proj-picker-list">
            {branches.map((b) => (
              <button
                key={b}
                className="pw-tb-menu-item"
                role="menuitem"
                onClick={() => handleCheckout(b)}
                disabled={detached && b !== currentBranch}
                title={b}
              >
                <Icon.GitBranch size={13} />
                <span className="pw-proj-picker-item-name">{b}</span>
                {b === currentBranch ? <Icon.Check size={13} /> : null}
              </button>
            ))}
            {branches.length === 0 ? (
              <div className="pw-empty-hint" style={{ padding: "4px 8px" }}>
                没有本地分支
              </div>
            ) : null}
          </div>
          <div className="pw-tb-menu-sep" />
          {creating ? (
            <div className="sb-row sb-search">
              <Icon.GitBranch size={13} />
              <input
                className="sb-search-input"
                placeholder="新分支名称"
                value={newName}
                autoFocus
                onChange={(e) => setNewName(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") handleCreate();
                }}
              />
              {newName.trim() ? (
                <button className="sb-clear" onClick={handleCreate} title="创建并切换">
                  <Icon.Check size={13} />
                </button>
              ) : null}
            </div>
          ) : (
            <button className="pw-tb-menu-item" role="menuitem" onClick={() => setCreating(true)}>
              <Icon.Plus size={13} />
              <span>新建分支</span>
            </button>
          )}
        </div>
      ) : null}
    </div>
  );
}
