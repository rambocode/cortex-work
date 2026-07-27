// 研究报告落盘时的文件名与来源抬头——渲染进程导出（写作空间/闪记）与主进程归档
// （项目目录/Documents）共用同一份规则，避免两边各写一套、名字对不上。
//
// 放在 core 而不是 views：主进程的归档路径也要用它，而 core 是两端唯一的公共祖先。

/// 文件名里不安全的字符：路径分隔符 + Windows 非法字符 + C0 控制符与 DEL。
///
/// 研究目标是用户自由输入的一句话，直接当文件名会撞到路径穿越（`../`）、
/// Windows 拒收的 `:*?"<>|`，以及粘贴带进来的换行/制表/不可见控制符。
// eslint-disable-next-line no-control-regex -- 就是要匹配控制字符本身
const UNSAFE_FILENAME_CHARS = /[\\/:*?"<>|\u0000-\u001F\u007F]+/g;

/// Windows 设备保留名（大小写不敏感）。这些名字连带任意扩展名都无法创建，
/// `CON.md` 同样被拒——所以判定的是整个 base name，不是「去掉扩展名之后」。
const WINDOWS_RESERVED_NAMES = new Set([
  "CON",
  "PRN",
  "AUX",
  "NUL",
  ...Array.from({ length: 9 }, (_, i) => `COM${i + 1}`),
  ...Array.from({ length: 9 }, (_, i) => `LPT${i + 1}`),
]);

/// 文件名长度上限（按 code point 计）。
///
/// 完整目标动辄几十上百字，做成文件名在文件树里没法看；60 个字已经足够辨认是哪一次研究，
/// 又给长期归档留了辨识度（早期是 40，归档场景下太容易撞名）。
const MAX_BASE_NAME_CODE_POINTS = 60;

/// 首尾的点号与空白：Windows 会静默丢弃文件名末尾的 `.` 与空格，导致「写进去的名字」
/// 和「磁盘上的名字」不一致；前导点则会让文件变成隐藏文件，甚至构成 `.`/`..` 这种目录引用。
const EDGE_DOTS_AND_SPACES = /^[.\s]+|[.\s]+$/g;

export interface ResearchReportNameInput {
  objective: string;
  sessionId: string;
}

/// 研究目标 → 报告文件名（不含扩展名）。
///
/// 清洗顺序是有讲究的，换顺序会漏：
/// 1. 非法字符换成空格（而不是删掉）——`a/b` 变 `a b` 保留词边界，删掉会粘成 `ab`。
/// 2. 折叠连续空白：上一步可能连续产出多个空格。
/// 3. 去首尾点号与空格：此时 `../../etc/passwd` 已是 `.. .. etc passwd`，这一步才吃掉前导点。
/// 4. 截断：必须在清洗之后，否则可能把已知安全的前缀截出个新的尾点。
/// 5. 截断后**再去一次尾部**点号空格：截断本身会暴露新的结尾。
/// 6. 空则回落 sessionId；最后才查保留名（长名字不可能撞保留名，加后缀也不会再超限）。
export function researchReportFileBaseName(input: ResearchReportNameInput): string {
  const cleaned = input.objective
    .replace(UNSAFE_FILENAME_CHARS, " ")
    .replace(/\s+/g, " ")
    .replace(EDGE_DOTS_AND_SPACES, "");

  // 按 code point 截而不是 `slice`：emoji、部分 CJK 扩展字符占两个 UTF-16 code unit，
  // 按 code unit 截会劈开代理对，落盘就是个乱码方块。
  const clipped = [...cleaned]
    .slice(0, MAX_BASE_NAME_CODE_POINTS)
    .join("")
    .replace(EDGE_DOTS_AND_SPACES, "");

  if (clipped.length === 0) {
    // 永远要有个名字。取 sessionId 前 8 位：够区分，又不会让文件名变成一串 UUID。
    return `research-${input.sessionId.slice(0, 8)}`;
  }

  return WINDOWS_RESERVED_NAMES.has(clipped.toUpperCase()) ? `${clipped}-report` : clipped;
}

/// 给报告加一段来源抬头。
///
/// 落到别处（写作空间 / 项目目录）之后，「这份内容是怎么来的」就只剩这段抬头能说明了——
/// 没有它，几周后翻到这个文件，没人认得出它是研究产物。
export function withResearchHeader(markdown: string, session: ResearchReportNameInput): string {
  return `> 来自 Cortex 深度研究：${session.objective}\n> 会话 ID：${session.sessionId}\n\n${markdown}`;
}
