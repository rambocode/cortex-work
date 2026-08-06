// Silero VAD 静态资产的 cortex-vad:// 只读协议。
//
// 资产(onnx 模型 / AudioWorklet bundle / onnxruntime-web 的 wasm+mjs)由
// electron.vite.config.ts 的内联插件 cortex-vad-assets 平铺拷进 out/renderer/vad/。
// dev 下渲染页是 http://localhost,同源相对路径 /vad/ 即可取到(同一插件的中间件服务),
// 不经本协议;打包态页面是 file://,fetch file:// 子资源被 CORS 拦死,渲染端改用
// cortex-vad://assets/<file> —— 本 handler 从 asar 内的 renderer/vad 目录读取回给它。
// 特权注册在 protocol-schemes.ts(单次调用收口),本模块只负责 handler。

import { protocol } from "electron";
import { promises as fsp } from "node:fs";
import { extname, join, normalize, sep } from "node:path";

export const VAD_ASSET_SCHEME = "cortex-vad";

// 按扩展名给正确的 MIME:AudioWorklet 的 addModule 要求 JS 类型;wasm 用标准类型
// 让 ort 能走流式编译(错类型会退化为 arrayBuffer 实例化,能用但慢)。
const MIME_BY_EXT: Record<string, string> = {
  ".js": "text/javascript",
  ".mjs": "text/javascript",
  ".wasm": "application/wasm",
  ".onnx": "application/octet-stream",
};

/** 注册协议 handler(app.ready 后调用)。只服务 renderer/vad 目录,路径穿越一律 403。 */
export function registerVadAssetProtocol(): void {
  protocol.handle(VAD_ASSET_SCHEME, async (request) => {
    try {
      // 形如 cortex-vad://assets/silero_vad_v5.onnx
      const url = new URL(request.url);
      if (url.host !== "assets") return new Response(null, { status: 403 });
      const file = normalize(decodeURIComponent(url.pathname)).replace(/^[/\\]+/, "");
      const root = join(__dirname, "../renderer/vad");
      const target = join(root, file);
      // 这条路径不经 IPC 参数校验,是任意文件读取的闸门:必须断言仍落在资产目录内。
      if (target !== root && !target.startsWith(root + sep)) return new Response(null, { status: 403 });
      const body = await fsp.readFile(target);
      return new Response(new Uint8Array(body), {
        headers: {
          "content-type": MIME_BY_EXT[extname(target).toLowerCase()] ?? "application/octet-stream",
          // 资产随应用版本更新,协议无指纹参数,不做强缓存。
          "cache-control": "no-cache",
          "access-control-allow-origin": "*",
        },
      });
    } catch {
      return new Response(null, { status: 404 });
    }
  });
}
