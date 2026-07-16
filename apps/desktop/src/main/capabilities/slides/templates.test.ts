// 内置模板注册表测试:扫真实 resources 目录(35 套随包模板),验证解析成功率、
// id 白名单、参考页读取的路径守卫。
import { describe, expect, it, vi } from "vitest";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

// app.getAppPath() → apps/desktop 根(开发态模板在 <root>/resources/slides/templates)。
const APP_PATH = fileURLToPath(new URL("../../../..", import.meta.url));

vi.mock("electron", () => ({
  app: { getAppPath: () => APP_PATH },
}));
vi.mock("../../log", () => ({
  createLogger: () => ({ error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() }),
}));

import {
  __resetTemplatesCacheForTest,
  getSlidesTemplate,
  listSlidesTemplates,
  readTemplateReferenceHtml,
  slidesTemplatesRoot,
} from "./templates";

describe("listSlidesTemplates", () => {
  it("解析随包模板:数量、必备字段与主题合法性", async () => {
    __resetTemplatesCacheForTest();
    const templates = await listSlidesTemplates();
    // 资源目录存在(否则本用例无意义)。
    expect(slidesTemplatesRoot()).toContain(join("resources", "slides", "templates"));
    expect(templates.length).toBeGreaterThanOrEqual(30);
    for (const t of templates) {
      expect(t.id).toMatch(/^[a-z0-9][a-z0-9-]*$/);
      expect(t.title.length).toBeGreaterThan(0);
      expect(t.theme.palette.background).toMatch(/^#[0-9a-fA-F]{6}$/);
      expect(t.theme.palette.foreground).toMatch(/^#[0-9a-fA-F]{6}$/);
      expect(["minimal", "balanced", "dense"]).toContain(t.theme.density);
    }
  });

  it("每套模板的正文与背景对比度可用(≥4.5,浅底不给浅字)", async () => {
    const templates = await listSlidesTemplates();
    const { contrastRatio } = await import("@cortex-work/core/design/slides/slides-templates");
    const weak = templates.filter((t) => contrastRatio(t.theme.palette.foreground, t.theme.palette.background) < 4.5);
    expect(weak.map((t) => t.id)).toEqual([]);
  });

  it("已知模板可按 id 取到,含 styleGuide 与参考页", async () => {
    const t = await getSlidesTemplate("quiet-axis");
    expect(t).not.toBeNull();
    expect(t!.styleGuide.length).toBeGreaterThan(100);
    expect(t!.referenceSlides[0]?.file).toBe("references/template.html");
  });

  it("非法 id 直接拒绝(不触碰文件系统)", async () => {
    expect(await getSlidesTemplate("../../etc")).toBeNull();
    expect(await getSlidesTemplate("Quiet-Axis")).toBeNull();
  });
});

describe("readTemplateReferenceHtml", () => {
  it("读取 manifest 声明的参考页", async () => {
    const html = await readTemplateReferenceHtml("quiet-axis", "references/template.html");
    expect(html).toBeTruthy();
    expect(html!.toLowerCase()).toContain("<!doctype html>");
  });

  it("拒绝未在 manifest 声明的任意路径(含穿越)", async () => {
    expect(await readTemplateReferenceHtml("quiet-axis", "../../../etc/passwd")).toBeNull();
    expect(await readTemplateReferenceHtml("quiet-axis", "template.json")).toBeNull();
    expect(await readTemplateReferenceHtml("nope-xyz", "references/template.html")).toBeNull();
  });
});
