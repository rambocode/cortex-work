// Slides 检查层:静态检查(HTML 字符串,纯函数)+ 渲染检查(render.ts 巡检数据映射)。
// 检查只产生结构化 findings(stable id / severity / slideId / elementId / hint),
// 不自动改写页面;修复由用户或 Agent 发起新的可追踪 revision。
import type { SlidesFinding, SlidesSlot } from "@cortex-work/core/design/slides/slides-types";
import type { SlideRenderInspection } from "./render";

/** 文本密度阈值:单页可见文本超过该字数视为过密(演示页应精炼)。 */
export const TEXT_DENSITY_WARN_CHARS = 800;
/** 单个内联 data URI 超过该字节数给出警告(拖慢加载/导出)。 */
export const DATA_URI_WARN_BYTES = 2 * 1024 * 1024;

function finding(
  slideId: string,
  code: string,
  n: number,
  severity: SlidesFinding["severity"],
  message: string,
  extra?: Partial<Pick<SlidesFinding, "elementId" | "hint">>,
): SlidesFinding {
  // stable id:同页同规则重跑映射到同一 finding(UI 去重/定位依赖)。
  return { id: `${slideId}:${code}:${n}`, severity, slideId, code, message, ...extra };
}

/**
 * 静态检查:不依赖渲染。规则:
 *  - doctype/utf-8 声明缺失(warning)
 *  - 远程资源引用(script src / link href / img src / url() 指向 http(s),blocking:
 *    远程 JS 违反页面合同;远程图片/样式为 warning)
 *  - 危险导航:window.open / top.location / target="_blank"(blocking)
 *  - 文本密度过高(warning)
 *  - 超大 data URI(warning)
 *  - 空页面启发:无任何可见标签(warning;渲染检查里有更准的 hasVisibleContent)
 */
export function staticCheckSlideHtml(slideId: string, html: string): SlidesFinding[] {
  const findings: SlidesFinding[] = [];
  let n = 0;

  if (!/^\s*<!doctype html>/i.test(html)) {
    findings.push(finding(slideId, "missing-doctype", n++, "warning", "页面缺少 <!doctype html> 声明"));
  }
  if (!/charset=["']?utf-?8/i.test(html)) {
    findings.push(finding(slideId, "missing-charset", n++, "warning", "页面未声明 UTF-8 编码"));
  }

  // 远程 JS:blocking(违反「不依赖远程 JavaScript」合同)。
  const remoteScript = /<script[^>]+src=["']https?:\/\/[^"']+["']/i.exec(html);
  if (remoteScript) {
    findings.push(
      finding(slideId, "remote-script", n++, "blocking", "页面引用了远程 JavaScript", {
        hint: "把脚本内联进页面,或移除该依赖",
      }),
    );
  }
  // 其他远程资源:warning(导出/离线播放会丢)。
  const remoteAsset =
    /<(?:img|link|source|video|audio)[^>]+(?:src|href)=["'](https?:\/\/[^"']+)["']/i.exec(html) ??
    /url\(\s*["']?(https?:\/\/[^"')]+)/i.exec(html);
  if (remoteAsset) {
    findings.push(
      finding(slideId, "remote-resource", n++, "warning", `页面引用了远程资源: ${remoteAsset[1]?.slice(0, 120)}`, {
        hint: "用 upload_asset 落到 deck assets/ 后改用相对路径或 data URI",
      }),
    );
  }

  if (/window\.open\s*\(/.test(html) || /top\.location/.test(html)) {
    findings.push(finding(slideId, "dangerous-navigation", n++, "blocking", "页面包含弹窗/顶层跳转脚本"));
  }
  if (/target=["']_blank["']/i.test(html)) {
    findings.push(finding(slideId, "external-link", n++, "warning", "页面包含外部跳转链接(演示中不可点)"));
  }

  // 文本密度:粗略去标签后统计。
  const textOnly = html
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<style[\s\S]*?<\/style>/gi, "")
    .replace(/<[^>]+>/g, "")
    .replace(/\s+/g, "");
  if (textOnly.length > TEXT_DENSITY_WARN_CHARS) {
    findings.push(
      finding(slideId, "text-density", n++, "warning", `页面文本约 ${textOnly.length} 字,可能过密`, {
        hint: "演示页建议精炼为要点,长内容拆页或移入备注",
      }),
    );
  }

  // 超大 data URI。
  const dataUriPattern = /data:[a-z/+.-]+;base64,([A-Za-z0-9+/=]+)/gi;
  let match: RegExpExecArray | null;
  while ((match = dataUriPattern.exec(html)) !== null) {
    const bytes = Math.floor((match[1]!.length * 3) / 4);
    if (bytes > DATA_URI_WARN_BYTES) {
      findings.push(
        finding(slideId, "oversized-data-uri", n++, "warning", `内联资源约 ${(bytes / 1024 / 1024).toFixed(1)}MB,过大`),
      );
      break;
    }
  }

  return findings;
}

/**
 * 渲染检查:把 render.ts 的巡检数据 + 截图空白度映射为 findings。
 *  - 内容越出画布 / 元素被裁切(blocking)
 *  - 最小字号 < 12px(warning)
 *  - 图片加载失败(blocking)
 *  - 空页面 / 空截图(blocking)
 */
export function renderInspectionFindings(
  slideId: string,
  inspection: SlideRenderInspection,
  screenshotBlankRatio: number,
): SlidesFinding[] {
  const findings: SlidesFinding[] = [];
  let n = 0;

  if (inspection.overflowX || inspection.overflowY) {
    findings.push(
      finding(slideId, "overflow", n++, "blocking", "内容越出 1280×720 画布", {
        hint: "收紧布局或缩小元素,保证整页在固定画布内",
      }),
    );
  }
  for (const el of inspection.clipped.slice(0, 10)) {
    findings.push(
      finding(slideId, "clipped", n++, "blocking", `元素超出画布边界(${el.x},${el.y} ${el.w}×${el.h})`, {
        elementId: el.id,
      }),
    );
  }
  for (const el of inspection.smallText.slice(0, 10)) {
    findings.push(
      finding(slideId, "min-font-size", n++, "warning", `文字过小(${el.fontSizePx}px < 12px)`, {
        elementId: el.id,
        hint: "演示场景建议正文不小于 14px",
      }),
    );
  }
  for (const img of inspection.brokenImages) {
    findings.push(
      finding(slideId, "image-load-failure", n++, "blocking", `图片加载失败: ${img.src}`, { elementId: img.id }),
    );
  }
  if (!inspection.hasVisibleContent || screenshotBlankRatio > 0.995) {
    findings.push(finding(slideId, "empty-slide", n++, "blocking", "页面渲染为空(无可见内容)"));
  }
  return findings;
}

/** findings 排序:blocking 优先,再按 slide 顺序稳定排列。 */
export function sortFindings(findings: SlidesFinding[], slotOrder: Map<string, number>): SlidesFinding[] {
  const weight = { blocking: 0, warning: 1, info: 2 } as const;
  return [...findings].sort(
    (a, b) =>
      weight[a.severity] - weight[b.severity] ||
      (slotOrder.get(a.slideId) ?? 0) - (slotOrder.get(b.slideId) ?? 0) ||
      a.id.localeCompare(b.id),
  );
}

/** 供 IPC/MCP 组合:一页的完整检查(静态 + 渲染结果已由调用方取得)。 */
export function combineSlideFindings(options: {
  slot: Pick<SlidesSlot, "id">;
  html: string;
  inspection?: SlideRenderInspection;
  screenshotBlankRatio?: number;
  renderError?: string;
}): SlidesFinding[] {
  const findings = staticCheckSlideHtml(options.slot.id, options.html);
  if (options.inspection) {
    findings.push(
      ...renderInspectionFindings(options.slot.id, options.inspection, options.screenshotBlankRatio ?? 0),
    );
  } else if (options.renderError) {
    findings.push({
      id: `${options.slot.id}:render-failed:0`,
      severity: "blocking",
      slideId: options.slot.id,
      code: "render-failed",
      message: `页面渲染失败: ${options.renderError}`,
    });
  }
  return findings;
}
