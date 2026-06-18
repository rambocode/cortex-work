// i18n 单例(react 绑定层)—— 每个渲染进程模块加载即 init 全局默认 i18next 实例。
//
// 桌面端 main / spotlight / notes 是三个独立渲染进程(独立 V8 realm),各自 import
// 本模块得到本进程的单例。单例只保证各窗口首屏默认 zh;跨进程语言一致由主进程
// app:locale 广播驱动(见 desktop/bridge 的 setLocale + U12)。
//
// 用全局默认实例(非 createInstance):同进程内绕过 CoreProvider 的 React 根
// (notes-overlay/spotlight)无需各自挂 <I18nextProvider> 即可解析 useTranslation。
// 仅在 import 本模块前于服务端/模块级调用 changeLanguage 才会破坏 SSR 安全(KTD1a)。

import i18next from "i18next";
import { initReactI18next } from "react-i18next";
import { i18nInitOptions } from "./config";
import type { Locale } from "./locales";

// 初始化就绪 Promise —— 测试 / 需要等待资源的消费方可 await。
// 全部命名空间已静态同步打入 resources(见 config.ts),init resolve 后所有 key 即可用,
// 无懒加载异步、无裸 key。
export const i18nReady: Promise<unknown> = i18next.isInitialized
  ? Promise.resolve()
  : i18next.use(initReactI18next).init(i18nInitOptions);

export const i18n = i18next;

// 调用时绑定当前语言的非 React t —— 供 core 非组件函数(toast / 通知文案)使用。
// bind 而非 `const t = i18next.t`:后者丢 this;bind 在调用时读 this.language,
// 故 changeLanguage 后返回新语言文案。
export const t = i18next.t.bind(i18next) as typeof i18next.t;

export function changeLanguage(lng: Locale): Promise<unknown> {
  return i18next.changeLanguage(lng);
}

export { LOCALES, DEFAULT_LOCALE, DEFAULT_NS, isLocale, type Locale } from "./locales";
export { useTranslation, Trans, I18nextProvider } from "react-i18next";
