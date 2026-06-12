// GitBar 数据 hook:轮询当前项目工作区 git 信息（分支 + ± 统计）。
// 刷新策略:5s 轮询(git 统计是计算型,watchDir 已被文件视图独占且对 .git
// 变化不可靠)+ GitBar 在 run 结束边沿主动 invalidate(commit 完成立即刷新)。

import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useDesktopBridge } from "../provider";
import type { GitInfoResult } from "../desktop/types";

export const gitInfoKeys = {
  detail: (projectPath: string) => ["gitInfo", projectPath] as const,
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
