// 研究报告归档落盘：把完成的报告写进「所选项目」目录，无项目时落 Documents 兜底。
//
// **为什么归档在主进程而不是 renderer**（D8）：renderer 只允许传 projectId，不允许传路径——
// 让渲染端指定落盘路径等于开了一条「指挥主进程往任意目录写文件」的通道。项目 id → 路径
// 的解析在 runtime.ts 的注入实现里按 id 现查 personal-workspace.json 完成。
//
// 文件名与来源抬头的规则不在这里，而在 @cortex-work/core/research/report-export：
// renderer 侧的导出（写作空间 / 闪记）与这里的归档必须叫同一个名字，规则只能有一份。
import { promises as fsp } from "node:fs";
import { join, resolve, sep } from "node:path";
import {
  researchReportFileBaseName,
  withResearchHeader,
} from "@cortex-work/core/research/report-export";
import { documentsCortexDir } from "../paths";

/// 归档一份报告所需的全部信息。projectPath 已由调用方解析完毕（null = 不使用项目）。
export interface ArchiveResearchReportInput {
  sessionId: string;
  objective: string;
  markdown: string;
  /// 项目目录的绝对路径；null 表示不使用项目，落 Documents 兜底目录。
  projectPath: string | null;
}

/// 撞名递增的最大尝试次数：`<名字>.md`、`<名字> (2).md` … `<名字> (50).md`。
/// 有上限是因为每次尝试都是一次真实的 open(wx) 系统调用——目录里真堆了几百个同名报告时，
/// 无限试下去只会让归档越来越慢，不如直接回落到带 sessionId 的必然唯一名。
const MAX_NAME_ATTEMPTS = 50;

/// 归档目录：项目下的 `research/`，或 Documents 兜底 `<documentsCortexDir()>/research/`。
///
/// 兜底沿用既有的小写 `~/Documents/cortex`（documentsCortexDir），不新造大写根目录——
/// 否则用户会在文稿里看到两个语义相同、只有大小写不同的目录。
export function resolveResearchArchiveDir(projectPath: string | null): string {
  return join(projectPath ?? documentsCortexDir(), "research");
}

/// 把报告写进归档目录，返回落盘的绝对路径。
///
/// **绝不覆盖已有文件**：同一目标连跑两次是常见操作，直接盖掉上一份等于静默丢数据。
/// 用 `flag: "wx"` 而不是「先 stat 再写」——后者两步之间有窗口期，同时完成的两次归档
/// 会双双认为文件不存在，然后其中一份被另一份覆盖（TOCTOU）。wx 让内核来裁决唯一性，
/// 撞上 EEXIST 就换下一个候选名重试。
export async function archiveResearchReport(input: ArchiveResearchReportInput): Promise<string> {
  const dir = resolveResearchArchiveDir(input.projectPath);
  await fsp.mkdir(dir, { recursive: true });

  const naming = { objective: input.objective, sessionId: input.sessionId };
  const baseName = researchReportFileBaseName(naming);
  const body = withResearchHeader(input.markdown, naming);

  for (let attempt = 1; attempt <= MAX_NAME_ATTEMPTS; attempt += 1) {
    const fileName = attempt === 1 ? `${baseName}.md` : `${baseName} (${attempt}).md`;
    const written = await tryWrite(dir, fileName, body);
    if (written) return written;
  }

  // 递增撞满：退回带 sessionId 的名字。它在同一目录里必然唯一（一个会话只归档一次），
  // 所以这一次再撞上就是真异常了，让它抛出去由调用方 warn。
  const fallbackName = `${baseName}-${input.sessionId.slice(0, 8)}.md`;
  const written = await tryWrite(dir, fallbackName, body);
  if (written) return written;
  throw new Error(`研究报告归档失败：${join(dir, fallbackName)} 已存在`);
}

/// 尝试独占创建一个文件；已存在返回 null（换下一个候选名），其余错误原样抛出。
///
/// 落盘前再做一次 resolve 包含性校验：文件名理应已被 researchReportFileBaseName 清洗干净，
/// 这里是纵深防御——万一清洗规则将来被改松，路径穿越也只会在这里报错，而不是真的写出去。
async function tryWrite(dir: string, fileName: string, body: string): Promise<string | null> {
  const target = resolve(dir, fileName);
  const dirPrefix = resolve(dir) + sep;
  if (!target.startsWith(dirPrefix)) {
    throw new Error(`研究报告归档失败：文件名越出归档目录（${fileName}）`);
  }

  try {
    await fsp.writeFile(target, body, { encoding: "utf8", flag: "wx" });
    return target;
  } catch (err) {
    if ((err as NodeJS.ErrnoException)?.code === "EEXIST") return null;
    throw err;
  }
}
