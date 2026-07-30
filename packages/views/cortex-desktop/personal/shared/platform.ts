// 个人工作区共享平台探测工具（叶子模块，无业务依赖）。

// 显示用 isMac：views 不直接读 window，经 navigator 即时探测（ComposerShell / FilesView / 设置各分区共用）。
export function detectIsMac(): boolean {
  if (typeof navigator === "undefined") return false;
  return /Mac|iPhone|iPad|iPod/.test(navigator.platform || navigator.userAgent || "");
}
