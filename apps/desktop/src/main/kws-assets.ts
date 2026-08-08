// 唤醒词(openWakeWord) ONNX 模型的 cortex-kws:// 只读协议。
//
// 与 vad-assets.ts 完全同构：模型由 electron.vite.config.ts 的 kwsAssetsPlugin 从
// resources/kws/ 平铺拷进 out/renderer/kws/；dev 下 kws 窗口同源 /kws/ 直取，打包态
// 页面是 file://，fetch 子资源被 CORS 拦死，改经本协议从 asar 读取。
// onnxruntime-web 的 wasm 不在这里——kws 窗口复用 cortex-vad://assets/ 里的那份，
// 版本由 package.json 里 pin 的 onnxruntime-web@1.27.0 与 vad-web 传递依赖对齐。
// 特权注册在 protocol-schemes.ts（单次调用收口），本模块只负责 handler。

import { protocol } from "electron";
import { promises as fsp } from "node:fs";
import { extname, join, normalize, sep } from "node:path";

export const KWS_ASSET_SCHEME = "cortex-kws";

const MIME_BY_EXT: Record<string, string> = {
  ".onnx": "application/octet-stream",
};

/** 注册协议 handler(app.ready 后调用)。只服务 renderer/kws 目录,路径穿越一律 403。 */
export function registerKwsAssetProtocol(): void {
  protocol.handle(KWS_ASSET_SCHEME, async (request) => {
    try {
      // 形如 cortex-kws://assets/melspectrogram.onnx
      const url = new URL(request.url);
      if (url.host !== "assets") return new Response(null, { status: 403 });
      const file = normalize(decodeURIComponent(url.pathname)).replace(/^[/\\]+/, "");
      const root = join(__dirname, "../renderer/kws");
      const target = join(root, file);
      // 这条路径不经 IPC 参数校验,是任意文件读取的闸门:必须断言仍落在资产目录内。
      if (target !== root && !target.startsWith(root + sep)) return new Response(null, { status: 403 });
      const body = await fsp.readFile(target);
      return new Response(new Uint8Array(body), {
        headers: {
          "content-type": MIME_BY_EXT[extname(target).toLowerCase()] ?? "application/octet-stream",
          "cache-control": "no-cache",
          "access-control-allow-origin": "*",
        },
      });
    } catch {
      return new Response(null, { status: 404 });
    }
  });
}
