import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { changeLanguage, i18n, i18nReady, t } from "./index";
import * as i18nReimport from "./index";
import { NAMESPACES, initialResources } from "./config";

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
    // 自带探针:zh 有、en 无的 key,断言 fallbackLng 回退到 zh 源串(不依赖真实词典缺漏)。
    // key 为运行时注入,绕过强类型 key 检查。
    const probe = i18n.t.bind(i18n) as (k: string) => string;
    i18n.addResourceBundle("zh-Hans", "common", { __fallbackProbe: "回退中文串" }, true, true);
    await changeLanguage("en");
    expect(probe("__fallbackProbe")).toBe("回退中文串");
    expect(probe("__fallbackProbe")).not.toBe("__fallbackProbe");
  });

  it("是同一全局单例(多处 import 引用相等)", () => {
    expect(i18nReimport.i18n).toBe(i18n);
  });

  it("changeLanguage 返回 Promise", () => {
    expect(changeLanguage("zh-Hans")).toBeInstanceOf(Promise);
  });

  // 防懒加载回归:真实应用无 test setup 的 loadAllResourcesForTest,故全部命名空间必须由
  // config 静态打包同步存在,否则非 common 命名空间(如 settings)在运行期渲染裸 key。
  it("config 静态打包全部命名空间,settings 等非 common 命名空间同步可解析", () => {
    for (const ns of NAMESPACES) {
      expect(initialResources["zh-Hans"]).toHaveProperty(ns);
      expect(initialResources["en"]).toHaveProperty(ns);
    }
    expect(Object.keys(initialResources["zh-Hans"] as object)).toContain("settings");
    // 直接从打包资源取(不经 t 的命名空间推断),证明 config 即提供 settings。
    expect(i18n.getResource("zh-Hans", "settings", "tabs.profile")).toBe("个人资料");
  });

  // 设置菜单分组(应用→浏览器):组标题 + 新增「浏览器」项的文案中英同步。
  it("settings 提供菜单分组标题与浏览器项文案(中英)", () => {
    expect(i18n.getResource("zh-Hans", "settings", "tabs.browser")).toBe("浏览器");
    expect(i18n.getResource("en", "settings", "tabs.browser")).toBe("Browser");
    expect(i18n.getResource("zh-Hans", "settings", "tabGroups.apps")).toBe("应用");
    expect(i18n.getResource("en", "settings", "tabGroups.apps")).toBe("Apps");
  });
});
