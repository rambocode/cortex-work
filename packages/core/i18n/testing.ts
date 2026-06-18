/// <reference types="vite/client" />
// 测试专用:把全部命名空间资源(zh-Hans + en)同步灌入 i18next,使 t() 首渲染即返回
// 真实值(规避 resourcesToBackend 懒加载的异步,U5/R12)。import.meta.glob 在新增命名空间
// JSON 后自动纳入,无需手维护清单。仅供测试 setup 调用,勿在运行时引入。

import { i18n } from "./index";

type JsonModule = { default: Record<string, unknown> };

const zhModules = import.meta.glob<JsonModule>("./resources/zh-Hans/*.json", { eager: true });
const enModules = import.meta.glob<JsonModule>("./resources/en/*.json", { eager: true });

function nsOf(path: string): string {
  return path.split("/").pop()!.replace(/\.json$/, "");
}

function addAll(lng: string, modules: Record<string, JsonModule>): void {
  for (const [path, mod] of Object.entries(modules)) {
    i18n.addResourceBundle(lng, nsOf(path), mod.default, true, true);
  }
}

export function loadAllResourcesForTest(): void {
  addAll("zh-Hans", zhModules);
  addAll("en", enModules);
}
