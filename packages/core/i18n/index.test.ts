import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { changeLanguage, i18n, i18nReady, t } from "./index";
import * as i18nReimport from "./index";

beforeAll(async () => {
  await i18nReady;
  await changeLanguage("zh-Hans");
});

afterAll(async () => {
  await changeLanguage("zh-Hans");
});

describe("i18n 单例", () => {
  it("默认语言下 t() 返回 zh 源串", () => {
    expect(t("save")).toBe("保存");
    expect(t("language.label")).toBe("语言");
  });

  it("切到 en 后 t() 返回英文", async () => {
    await changeLanguage("en");
    expect(t("save")).toBe("Save");
    expect(i18n.language).toBe("en");
  });

  it("en 缺失的 key 回退到 zh 源串,绝不渲染裸 key(R3)", async () => {
    await changeLanguage("en");
    // en/common.json 故意省略 "close" —— 应回退中文。
    expect(t("close")).toBe("关闭");
    expect(t("close")).not.toBe("close");
  });

  it("是同一全局单例(多处 import 引用相等)", () => {
    expect(i18nReimport.i18n).toBe(i18n);
  });

  it("changeLanguage 返回 Promise", () => {
    expect(changeLanguage("zh-Hans")).toBeInstanceOf(Promise);
  });
});
