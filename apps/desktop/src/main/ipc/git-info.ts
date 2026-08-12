// git 信息条相关纯逻辑:解析 git 输出、统计 ± 行数、为
// untracked 文件合成 diff。不 import electron,便于单测(同 watch-noise.ts 模式)。

export interface NumstatRow {
  add: number;
  del: number;
  path: string;
  binary: boolean;
}

// 解析 `git diff HEAD --numstat` 输出:每行 "<add>\t<del>\t<path>",
// 二进制文件为 "-\t-\t<path>"(计 0 行,与 git show --stat 一致)。
export function parseNumstat(stdout: string): NumstatRow[] {
  return stdout
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      const [a, d, ...rest] = line.split("\t");
      const binary = a === "-" || d === "-";
      return {
        add: binary ? 0 : Number(a) || 0,
        del: binary ? 0 : Number(d) || 0,
        path: rest.join("\t"),
        binary,
      };
    })
    .filter((r) => r.path);
}

// 从 `git status --porcelain -uall` 输出取未跟踪文件相对路径("??" 行)。
// 防御:目录条目(尾部 "/")跳过——-uall 下不应出现,出现也无法按文件统计。
export function parseUntracked(porcelain: string): string[] {
  return porcelain
    .split("\n")
    .filter((line) => line.startsWith("?? "))
    .map((line) => line.slice(3).replace(/^"|"$/g, ""))
    .filter((rel) => rel && !rel.endsWith("/"));
}

// untracked 文件全文按新增行计。与 git 一致:末行无换行符也算一行;空文件 0 行。
export function countAddedLines(content: string): number {
  if (content === "") return 0;
  const parts = content.split("\n");
  return content.endsWith("\n") ? parts.length - 1 : parts.length;
}

// tracked numstat + untracked 行数 → ± 总计(untracked 全部计 additions)。
export function sumStats(tracked: NumstatRow[], untrackedLineCounts: number[]): { additions: number; deletions: number } {
  let additions = 0;
  let deletions = 0;
  for (const row of tracked) {
    additions += row.add;
    deletions += row.del;
  }
  for (const n of untrackedLineCounts) additions += n;
  return { additions, deletions };
}

// 为 untracked 文件合成标准 unified diff 片段(content 为 null 表示二进制)。
// 走纯合成而非 `git diff --no-index`:规避其退出码 1 与 /dev/null 跨平台问题。
export function synthUntrackedDiff(rel: string, content: string | null): string {
  const head = `diff --git a/${rel} b/${rel}\nnew file mode 100644\n--- /dev/null\n+++ b/${rel}\n`;
  if (content === null) return `${head}Binary files /dev/null and b/${rel} differ\n`;
  const lines = countAddedLines(content);
  if (lines === 0) return head;
  const body = (content.endsWith("\n") ? content.slice(0, -1) : content)
    .split("\n")
    .map((l) => `+${l}`)
    .join("\n");
  const noEol = content.endsWith("\n") ? "" : "\n\\ No newline at end of file";
  return `${head}@@ -0,0 +1,${lines} @@\n${body}${noEol}\n`;
}
