// GitBar 数据 hook:轮询当前项目工作区 git 信息（分支 + ± 统计）。
// 刷新策略:5s 轮询(git 统计是计算型,watchDir 已被文件视图独占且对 .git
// 变化不可靠)+ GitBar 在 run 结束边沿主动 invalidate(commit 完成立即刷新)。

import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useDesktopBridge } from "../provider";
import type { GitBranchesResult, GitInfoResult, GitOpResult } from "../desktop/types";

export const gitInfoKeys = {
  detail: (projectPath: string) => ["gitInfo", projectPath] as const,
};

export const gitBranchKeys = {
  list: (path: string) => ["gitBranches", path] as const,
};

export function useProjectGitInfo(projectPath: string | undefined): GitInfoResult | undefined {
  const bridge = useDesktopBridge();
  const { data } = useQuery<GitInfoResult>({
    queryKey: gitInfoKeys.detail(projectPath ?? "none"),
    enabled: !!bridge?.gitInfo && !!projectPath,
    staleTime: 4_000,
    refetchInterval: 5_000,
    refetchOnWindowFocus: true,
    queryFn: () => bridge!.gitInfo!(projectPath!),
  });
  return data;
}

// run 结束（running true→false 边沿）后立即刷新统计,避免等下一轮轮询。
export function useInvalidateGitInfo(): (projectPath: string) => void {
  const qc = useQueryClient();
  return (projectPath: string) => {
    void qc.invalidateQueries({ queryKey: gitInfoKeys.detail(projectPath) });
  };
}

// GitBar 分支选择:本地分支列表 + 当前分支。仿 useProjectGitInfo 的轮询策略。
export function useProjectBranches(projectPath: string | undefined): GitBranchesResult | undefined {
  const bridge = useDesktopBridge();
  const { data } = useQuery<GitBranchesResult>({
    queryKey: gitBranchKeys.list(projectPath ?? "none"),
    enabled: !!bridge?.gitBranches && !!projectPath,
    staleTime: 4_000,
    refetchInterval: 5_000,
    refetchOnWindowFocus: true,
    queryFn: () => bridge!.gitBranches!(projectPath!),
  });
  return data;
}

// GitBar 分支操作:新建 / 切换。成功后 invalidate 分支列表与 git 统计,立即刷新 UI。
export function useGitBranchActions(): {
  createBranch: (path: string, name: string) => Promise<GitOpResult>;
  checkout: (path: string, name: string) => Promise<GitOpResult>;
} {
  const bridge = useDesktopBridge();
  const qc = useQueryClient();
  const refresh = (path: string) => {
    void qc.invalidateQueries({ queryKey: gitBranchKeys.list(path) });
    void qc.invalidateQueries({ queryKey: gitInfoKeys.detail(path) });
  };
  return {
    createBranch: async (path, name) => {
      if (!bridge?.gitCreateBranch) return { ok: false, message: "当前环境不支持分支操作" };
      const res = await bridge.gitCreateBranch(path, name);
      if (res.ok) refresh(path);
      return res;
    },
    checkout: async (path, name) => {
      if (!bridge?.gitCheckout) return { ok: false, message: "当前环境不支持分支操作" };
      const res = await bridge.gitCheckout(path, name);
      if (res.ok) refresh(path);
      return res;
    },
  };
}
