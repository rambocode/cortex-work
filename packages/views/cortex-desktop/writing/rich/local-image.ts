// 富文本本地图片节点(精简自 Kun WriteLocalImage,去掉信息图/HTML 嵌入等 Kun 专属能力)。
// 关键:节点的 src 属性始终保留「原始(通常是工作区相对)」值用于 Markdown 序列化,保证 ![](./x.png)
// 往返无损;显示时通过注入的 resolve() 把相对路径异步解析成可渲染的 data: URL(远程/绝对直接用)。
//
// ⚠️ 顶层 import 了 @tiptap/*,只允许被动态 import 触达(见 markdown-manager.ts 同款约束)。
import { Image } from "@tiptap/extension-image";

export interface WriteLocalImageOptions {
  // 把原始 src(相对/绝对/远程)解析成可直接渲染的 URL;返回 null 表示无法解析(保持原样)。
  // 由 WritingEditorPane 注入:相对路径按当前 .md 文件目录拼绝对路径,再经 bridge.imageRead 读成 data URL。
  resolve: ((rawSrc: string) => Promise<string | null>) | null;
}

// 可直接用作 <img src> 的协议(无需经 bridge 读盘)。
function isDirectlyRenderable(src: string): boolean {
  return /^(https?:|data:|blob:|file:)/i.test(src);
}

// Image 扩展 + 自定义节点视图:序列化仍用原始 src,显示用解析后的 URL。
export const WriteLocalImage = Image.extend<WriteLocalImageOptions>({
  addOptions() {
    return {
      ...this.parent?.(),
      resolve: null,
    };
  },

  addNodeView() {
    return ({ node }) => {
      const img = document.createElement("img");
      const raw = typeof node.attrs.src === "string" ? node.attrs.src : "";
      const alt = typeof node.attrs.alt === "string" ? node.attrs.alt : "";
      if (alt) img.alt = alt;
      // 保留原始 src 以便调试 / 复制;实际显示 src 下面决定。
      img.setAttribute("data-raw-src", raw);

      if (isDirectlyRenderable(raw)) {
        img.src = raw;
      } else if (this.options.resolve) {
        // 相对/工作区路径:异步解析为 data URL 再填 src(解析失败则保持空,浏览器显示占位)。
        void this.options
          .resolve(raw)
          .then((resolved) => {
            if (resolved) img.src = resolved;
          })
          .catch(() => {
            /* 解析失败:留空,不阻断编辑 */
          });
      }

      return { dom: img };
    };
  },
});
