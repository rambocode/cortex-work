// react-i18next 实例的初始化选项。
// - 默认/源/回退语言都是 zh-Hans(KTD2):缺失 en key 回退中文源串,绝不渲染裸 key。
// - 全部命名空间静态 import 同步打入 resources:Electron + Next(CSR)体量小(数百 key),
//   懒加载(动态 import / import.meta.glob)在真实构建里路径脆弱且 Next/webpack 不支持 vite glob,
//   故全量同步打包,保证任一窗口/首屏即解析,无异步/无裸 key。新增命名空间需在此登记。
// - useSuspense:false —— 资源未就绪时返回回退值而非抛 Suspense。

import type { InitOptions, Resource } from "i18next";
import { DEFAULT_LOCALE, DEFAULT_NS } from "./locales";

import commonZh from "./resources/zh-Hans/common.json";
import settingsZh from "./resources/zh-Hans/settings.json";
import spotlightZh from "./resources/zh-Hans/spotlight.json";
import chatZh from "./resources/zh-Hans/chat.json";
import notesZh from "./resources/zh-Hans/notes.json";
import filesZh from "./resources/zh-Hans/files.json";
import timelineZh from "./resources/zh-Hans/timeline.json";
import petZh from "./resources/zh-Hans/pet.json";
import browserZh from "./resources/zh-Hans/browser.json";

import commonEn from "./resources/en/common.json";
import settingsEn from "./resources/en/settings.json";
import spotlightEn from "./resources/en/spotlight.json";
import chatEn from "./resources/en/chat.json";
import notesEn from "./resources/en/notes.json";
import filesEn from "./resources/en/files.json";
import timelineEn from "./resources/en/timeline.json";
import petEn from "./resources/en/pet.json";
import browserEn from "./resources/en/browser.json";

export const NAMESPACES = [
  "common",
  "settings",
  "spotlight",
  "chat",
  "notes",
  "files",
  "timeline",
  "pet",
  "browser",
] as const;

export const initialResources: Resource = {
  "zh-Hans": {
    common: commonZh,
    settings: settingsZh,
    spotlight: spotlightZh,
    chat: chatZh,
    notes: notesZh,
    files: filesZh,
    timeline: timelineZh,
    pet: petZh,
    browser: browserZh,
  },
  en: {
    common: commonEn,
    settings: settingsEn,
    spotlight: spotlightEn,
    chat: chatEn,
    notes: notesEn,
    files: filesEn,
    timeline: timelineEn,
    pet: petEn,
    browser: browserEn,
  },
};

export const i18nInitOptions: InitOptions = {
  lng: DEFAULT_LOCALE,
  fallbackLng: DEFAULT_LOCALE,
  defaultNS: DEFAULT_NS,
  ns: [...NAMESPACES],
  resources: initialResources,
  interpolation: { escapeValue: false },
  react: { useSuspense: false },
  returnNull: false,
};
