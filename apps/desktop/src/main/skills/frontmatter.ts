// skill frontmatter 解析（纯函数,无 electron/fs 依赖,可单测）。只解析首个 --- ... --- 块,
// 取 name / description / argument-hint 三键,去首尾引号。移植 server parseSkillFrontmatter
// 思路并扩 argument-hint。未知键（allowed-tools / model 等）忽略。
export function parseFrontmatter(content: string): {
  name?: string;
  description?: string;
  argumentHint?: string;
} {
  if (!content.startsWith("---")) return {};
  const end = content.indexOf("\n---", 3);
  if (end < 0) return {};
  const block = content.slice(3, end);
  const out: { name?: string; description?: string; argumentHint?: string } = {};
  for (const raw of block.split("\n")) {
    const line = raw.trim();
    const take = (key: string): string =>
      line.slice(key.length).trim().replace(/^["']|["']$/g, "");
    if (line.startsWith("name:")) out.name = take("name:");
    else if (line.startsWith("description:")) out.description = take("description:");
    else if (line.startsWith("argument-hint:")) out.argumentHint = take("argument-hint:");
  }
  return out;
}
