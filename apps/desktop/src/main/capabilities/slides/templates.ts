// 内置 Slides 模板注册表(主进程):扫描 resources/slides/templates/<id>/,
// 解析 TEMPLATE.md frontmatter + template.json → 归一化 summary(纯函数在 core)。
//
// 打包契约:模板是 extraResources(随包分发、只读),开发期在仓库 apps/desktop/resources 下,
// 打包后在 process.resourcesPath —— 两处都探测,缺失时降级为空列表(不阻断 Slides 使用)。
// 安全:模板 id 只允许 [a-z0-9-](即目录名),杜绝借 id 穿越到资源目录之外。
import { promises as fsp } from "node:fs";
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { app } from "electron";
import {
  buildTemplateSummary,
  isValidTemplateId,
  type SlidesTemplateJson,
  type SlidesTemplateSummary,
} from "@cortex-work/core/design/slides/slides-templates";
import { createLogger } from "../../log";

const log = createLogger("slides");

/** 模板根目录:打包态取 resourcesPath,开发态取仓库内 resources。 */
export function slidesTemplatesRoot(): string {
  const packaged = join(process.resourcesPath ?? "", "slides", "templates");
  if (process.resourcesPath && existsSync(packaged)) return packaged;
  // 开发态:apps/desktop/resources/slides/templates(相对 app 根)。
  const dev = join(app.getAppPath(), "resources", "slides", "templates");
  return dev;
}

let cache: SlidesTemplateSummary[] | null = null;

/** 列出内置模板(首次扫描后缓存;资源只读,不需失效)。 */
export async function listSlidesTemplates(): Promise<SlidesTemplateSummary[]> {
  if (cache) return cache;
  const root = slidesTemplatesRoot();
  let dirs: string[];
  try {
    const entries = await fsp.readdir(root, { withFileTypes: true });
    dirs = entries.filter((e) => e.isDirectory() && isValidTemplateId(e.name)).map((e) => e.name);
  } catch {
    // 资源缺失(未打包/路径变更)→ 降级为无模板,不阻断 Slides 主流程。
    log.warn(`[slides] templates root unavailable: ${root}`);
    cache = [];
    return cache;
  }
  const summaries: SlidesTemplateSummary[] = [];
  for (const id of dirs.sort()) {
    const summary = await readTemplate(root, id);
    if (summary) summaries.push(summary);
  }
  log.info(`[slides] templates loaded: ${summaries.length} from ${root}`);
  cache = summaries;
  return cache;
}

async function readTemplate(root: string, id: string): Promise<SlidesTemplateSummary | null> {
  try {
    const dir = join(root, id);
    const [markdown, jsonRaw] = await Promise.all([
      fsp.readFile(join(dir, "TEMPLATE.md"), "utf8"),
      fsp.readFile(join(dir, "template.json"), "utf8"),
    ]);
    const json = JSON.parse(jsonRaw) as SlidesTemplateJson;
    return buildTemplateSummary({ id, markdown, json });
  } catch (err) {
    log.warn(`[slides] template ${id} skipped: ${String(err)}`);
    return null;
  }
}

export async function getSlidesTemplate(id: string): Promise<SlidesTemplateSummary | null> {
  if (!isValidTemplateId(id)) return null;
  const all = await listSlidesTemplates();
  return all.find((t) => t.id === id) ?? null;
}

/**
 * 读取模板参考页 HTML(预览/Agent 参照用)。
 * 路径校验:id 过形状白名单,file 必须是 template.json 声明的相对路径之一,
 * 且解析后仍在该模板目录内 —— 不接受任意路径。
 */
export async function readTemplateReferenceHtml(id: string, file: string): Promise<string | null> {
  const template = await getSlidesTemplate(id);
  if (!template) return null;
  if (!template.referenceSlides.some((r) => r.file === file)) return null;
  const dir = resolve(slidesTemplatesRoot(), id);
  const target = resolve(dir, file);
  if (target !== dir && !target.startsWith(dir + "/")) return null;
  try {
    return await fsp.readFile(target, "utf8");
  } catch {
    return null;
  }
}

/** 测试用:清空缓存。 */
export function __resetTemplatesCacheForTest(): void {
  cache = null;
}
