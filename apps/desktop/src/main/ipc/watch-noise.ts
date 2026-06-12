// 文件变更噪声过滤（fs.watch 回调共用）。构建/依赖目录 + macOS 系统后台写入
// 不是用户/agent 干活,不触发目录刷新。独立成纯函数便于单测（不 import electron）。

const NOISY_SEGMENTS = new Set([
  ".git",
  "node_modules",
  ".next",
  ".turbo",
  "dist",
  "out",
  "build",
  ".cache",
  ".venv",
  "venv",
  "__pycache__",
  "target",
  ".DS_Store",
]);

export function isNoisyChange(filename: string | null | undefined): boolean {
  if (!filename) return false; // 平台可能不给 filename,宁可刷新也别漏
  const segs = String(filename).split(/[/\\]/);
  if (segs.some((s) => NOISY_SEGMENTS.has(s))) return true;
  const name = segs[segs.length - 1] ?? "";
  return name === ".DS_Store" || name.endsWith("~") || name.endsWith(".swp") || name.startsWith(".com.apple.");
}
