// claude 原生 skill 桥接目录构建(U1)。把「当前已启用的 skill 记录」物化成 claude CLI 能原生
// 发现的目录结构:<bridgeRootDir>/.claude/skills/<slug>/ → symlink 指向真实 skill 目录。cli.ts 再
// 把 <bridgeRootDir> 经 `--add-dir` 传给 claude —— claude 会自动加载附加目录下的 `.claude/skills/`,
// 并跟随 symlink 读到 target 里的 SKILL.md 及其 references/scripts(已实测验证,见下)。
//
// 为什么用 symlink 而非拷贝:实测(claude 2.1.197,应用现用的 `-p --input-format stream-json`
// + `--add-dir`)确认 claude 会跟随 `.claude/skills/<name>` 的 symlink 读到 target 目录里的
// SKILL.md 与 references/,无需把内容拷进桥接目录。若未来某版本不再跟随 symlink,再退回拷贝方案。
//
// 命令名对齐(R7 / KTD3):claude 的 `/<name>` 展开取自 **symlink 目录名**(SKILL.md frontmatter
// 的 `name` 不参与命令名派生 —— 已实测:目录名 `zebra-two-probe` 而 frontmatter `name` 不同时,
// claude 仍以 `/zebra-two-probe` 触发)。且 claude **不会**把带空格/大写的目录名归一化(实测:目录名
// `Zebra Two Probe` 时 `/zebra-two-probe` 报 Unknown command),但对「已是合法 slug 的目录名」是原样
// 采用。故本模块统一把 `skill.name` 先 slug 化成合法 slug(小写 + 连字符)再作为目录名,U5 的
// renderClaudeSkillSlash 用**同一套** slug 规则产出 `/<slug>`,两者由构造保证一致(而非分别发明规则)。
//
// 降级风格对齐 mcp-config.applyClaudeMcp:任何一步失败都不抛出未捕获异常、不阻断发送 —— 整体失败返回
// undefined(不追加 --add-dir),单条失败只跳过该条。

import { existsSync, mkdirSync, rmSync, statSync, symlinkSync } from "fs";
import { join } from "path";

import type { InjectableSkill } from "@cortex-work/core";

// 把 skill.name 归一为 claude 认得的合法 slash 命令名(= 桥接 symlink 目录名):
//   - 小写化;
//   - 任何非 [a-z0-9] 的连续段(空格、`/`、`\`、`..`、控制字符等)折叠成单个连字符 —— 同时满足
//     「文件系统安全(去路径分隔符/`..`/控制字符,链接名绝不逃逸出 skills 目录)」与「claude slug 合法」;
//   - 去掉首尾连字符。
// 结果可能为空串(name 全是符号),由调用方用短 hash 兜底。
export function slugifyClaudeSkillName(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

// 原始 name 的 8 位短 hash,用于:slug 为空的兜底名、同批次命名碰撞的消歧后缀。
// ⚠️ 跨进程契约(code review 修复):必须与渲染端 packages/core/personal/skill-injection.ts 的
// 同名函数逐字算法一致——否则渲染端 renderClaudeSkillSlash 推导出的裸 slash 会跟这里实际建的
// symlink 目录名不一致(空 slug 兜底/碰撞消歧场景下 claude 收到 Unknown command 或点错 skill)。
// 用纯算术哈希而非 crypto:core 端不能依赖 Node crypto(需可在渲染端/浏览器运行),故两侧统一改用
// 同一份无依赖实现,而不是「主进程用 sha256、渲染端用别的」各自发明。
function shortHash(s: string): string {
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = (h * 33) ^ s.charCodeAt(i);
  return (h >>> 0).toString(16).padStart(8, "0").slice(0, 8);
}

// 为一条记录算出「本批次内不冲突」的目录名。清洗后为空 → 用短 hash 兜底;与已占用名冲突(如
// `my/skill` 与 `my-skill` 都归一到 `my-skill`)→ 对后到者追加基于原始 name 的短 hash 后缀消歧,
// 避免 symlink 互相覆盖导致「点了 A 却执行 B」。
function resolveLinkName(name: string, used: Set<string>): string {
  const base = slugifyClaudeSkillName(name) || `skill-${shortHash(name)}`;
  if (!used.has(base)) return base;
  const suffixed = `${base}-${shortHash(name)}`;
  if (!used.has(suffixed)) return suffixed;
  // 极端:同一 name 出现多次 → hash 也相同,再叠加递增序号兜底。
  let i = 2;
  while (used.has(`${suffixed}-${i}`)) i++;
  return `${suffixed}-${i}`;
}

// 构建/刷新 claude 桥接目录。records 为空 → 返回 undefined(不建目录、无需 --add-dir)。
// 非空:清空 <bridgeRootDir>/.claude/skills/ 旧内容后,为每条记录建一个指向 record.dir 的 symlink,
// 返回 bridgeRootDir 供 --add-dir。全部建链失败(无有效链接)同样返回 undefined。
export function buildClaudeSkillBridge(records: InjectableSkill[], bridgeRootDir: string): string | undefined {
  if (!records.length) return undefined;

  const skillsDir = join(bridgeRootDir, ".claude", "skills");
  // 整目录删除重建:确保上一轮遗留的旧 symlink 不残留(重复调用场景),只保留本轮记录。
  try {
    rmSync(skillsDir, { recursive: true, force: true });
    mkdirSync(skillsDir, { recursive: true });
  } catch (e) {
    // 桥接目录无法准备 → 整体降级,不追加 --add-dir(对齐 applyClaudeMcp 降级风格)。
    console.warn("[claude-skill-bridge] 无法准备桥接目录,跳过原生 skill 加载:", e);
    return undefined;
  }

  const used = new Set<string>(); // 本批次已占用的目录名
  let linked = 0;
  for (const rec of records) {
    try {
      // 目标必须存在且为目录(skill 被手动删除等)→ 跳过该条,不影响其余。
      if (!rec.dir || !existsSync(rec.dir) || !statSync(rec.dir).isDirectory()) continue;
      const dirName = resolveLinkName(rec.name, used);
      used.add(dirName);
      // dirName 由 slug 化保证只含 [a-z0-9-],join 后必落在 skillsDir 内,不会目录穿越。
      symlinkSync(rec.dir, join(skillsDir, dirName), "dir");
      linked++;
    } catch (e) {
      // 单条建链失败只跳过,不中断其余、不抛出(对齐降级风格)。
      console.warn(`[claude-skill-bridge] 建链失败,跳过 skill「${rec.name}」:`, e);
    }
  }

  // 无一条成功建链 → --add-dir 一个空桥接目录无意义,返回 undefined。
  return linked > 0 ? bridgeRootDir : undefined;
}
