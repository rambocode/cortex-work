// 应用全部自定义协议的特权注册收口。
//
// Electron 的 protocol.registerSchemesAsPrivileged **整个进程只能调用一次**且必须在
// app.ready 之前——多个模块各自调用会互相覆盖(后调用者胜出,先注册的 scheme 静默失效)。
// 因此任何新自定义协议都必须把特权条目加进这里的单次调用,而不是自己再调一遍。
// 各协议的 handler 仍归各自模块注册(app.ready 后,见 registerPetdexHandlers /
// registerVadAssetProtocol)。

import { protocol } from "electron";
import { PETDEX_SCHEME } from "./ipc/petdex";
import { VAD_ASSET_SCHEME } from "./vad-assets";
import { KWS_ASSET_SCHEME } from "./kws-assets";

/** 注册全部自定义协议的特权。必须在 app.ready 之前、index.ts 模块顶层调用一次。 */
export function registerAppSchemes(): void {
  protocol.registerSchemesAsPrivileged([
    {
      // petdex 图鉴只读协议:corsEnabled 让渲染端可给 <img crossOrigin="anonymous">,
      // 保持 canvas 不被污染(原注册处注释迁移至此)。
      scheme: PETDEX_SCHEME,
      privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true, stream: true },
    },
    {
      // Silero VAD 静态资产只读协议:打包态页面是 file://,直接 fetch file:// 子资源会被
      // Chromium 的 CORS 拦下(onnx 模型 / ort wasm / AudioWorklet 都要经 fetch 或模块加载),
      // 走自定义协议统一供给。supportFetchAPI 是 ort 加载 wasm 的硬前提。
      scheme: VAD_ASSET_SCHEME,
      privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true, stream: true },
    },
    {
      // 唤醒词 ONNX 模型只读协议:与 vad 同因(打包态 file:// 页面 fetch 子资源被 CORS 拦),
      // kws 隐藏窗口经它取 openWakeWord 三级模型;wasm 复用 cortex-vad:// 里那份。
      scheme: KWS_ASSET_SCHEME,
      privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true, stream: true },
    },
  ]);
}
