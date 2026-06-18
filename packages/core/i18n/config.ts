// react-i18next 实例的初始化选项。
// - 默认/源/回退语言都是 zh-Hans(KTD2):缺失 en key 回退中文源串,绝不渲染裸 key。
// - common(zh + en)同步打入 resources,保证首屏 / SSR / 测试一致(KTD4);
//   其余命名空间由 i18n/index.ts 的 resourcesToBackend 懒加载。
// - useSuspense:false —— 资源未就绪时返回回退值而非抛 Suspense。

import type { InitOptions, Resource } from "i18next";
import { DEFAULT_LOCALE, DEFAULT_NS } from "./locales";
import commonZh from "./resources/zh-Hans/common.json";
import commonEn from "./resources/en/common.json";

export const initialResources: Resource = {
  "zh-Hans": { common: commonZh },
  en: { common: commonEn },
};

export const i18nInitOptions: InitOptions = {
  lng: DEFAULT_LOCALE,
  fallbackLng: DEFAULT_LOCALE,
  defaultNS: DEFAULT_NS,
  ns: [DEFAULT_NS],
  resources: initialResources,
  interpolation: { escapeValue: false },
  react: { useSuspense: false },
  returnNull: false,
};
