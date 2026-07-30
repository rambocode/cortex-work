// 选中片段 → 终端/Chat 的上下文拼装（借鉴 fanbox term.sendContext）。
// 纯函数,terminal 路径额外包 bracketed paste 防多行被 shell 逐行执行。

// 从绝对路径猜测 home 目录（renderer 拿不到 os.homedir;macOS/Linux 的
// /Users/<u> 与 /home/<u> 前缀足够覆盖本项目场景）。
export function guessHome(absPath: string): string | null {
  const m = /^(\/(?:Users|home)\/[^/]+)(?:\/|$)/.exec(absPath);
  return m ? m[1]! : null;
}

export function toTildePath(absPath: string): string {
  const home = guessHome(absPath);
  return home ? "~" + absPath.slice(home.length) : absPath;
}

// `（来自 ~/x/y.go 的片段）\n```\n<选中内容>\n```\n`;无路径时退化为「选中的片段」。
export function buildContextSnippet(absPath: string | undefined, selection: string): string {
  const head = absPath ? `（来自 ${toTildePath(absPath)} 的片段）` : "（选中的片段）";
  return `${head}\n\`\`\`\n${selection}\n\`\`\`\n`;
}

// 无选区时只引用文档路径:不套代码围栏,避免 buildContextSnippet 在空选区下产出空围栏。
export function buildPathRef(absPath: string): string {
  return `（来自 ${toTildePath(absPath)}）\n`;
}

// bracketed paste：多行内容当作一次粘贴,不会被 shell/TUI agent 逐行执行。
export function wrapBracketedPaste(text: string): string {
  return "\x1b[200~" + text + "\x1b[201~";
}

// 路径插入终端用:纯安全字符直接返回,否则 POSIX 单引号转义（' → '\''）。
export function shellQuotePath(path: string): string {
  if (/^[A-Za-z0-9_\-./~+@%:,=]+$/.test(path)) return path;
  return "'" + path.replaceAll("'", "'\\''") + "'";
}
