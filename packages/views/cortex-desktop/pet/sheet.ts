// sprite 图片的加载缓存。
//
// key 用资产 URL 而不是角色 id:同一只宠物换了图(petdex 的 ?v= 指纹变了)必须重新解码,
// 而同一张图被多处挂载(宠物本体 + 设置页预览 + 图鉴卡片)应当共享同一次解码。
// 缓存里存 Promise 而非 Image:并发请求同一张图时只发一次解码,后到者等同一个 Promise。
//
// ⚠️ 跨进程不共享:桌面端 pet-overlay 是独立 renderer,与主窗口各持一份缓存,这是预期的
// (Chromium 的 HTTP/协议层缓存会兜住重复的网络/磁盘读取)。

const cache = new Map<string, Promise<HTMLImageElement | null>>();

/**
 * 加载并解码一张 sprite。失败返回 null(调用方渲染空白而不是崩)。
 *
 * crossOrigin 必须在设 src **之前**赋值,否则不生效。当前只 drawImage 不读回像素,
 * 图被「污染」也不影响显示;但一旦将来要生成缩略图或 toBlob 就会撞 SecurityError,
 * 而 petdex 的 ACAO 是 `*`、cortex-petdex:// 协议也注册了 corsEnabled,匿名模式必然成功,
 * 所以现在就带上,省得半年后有人加缩略图时莫名其妙。
 */
export function loadSheetImage(url: string): Promise<HTMLImageElement | null> {
  const hit = cache.get(url);
  if (hit) return hit;

  const task = new Promise<HTMLImageElement | null>((resolve) => {
    if (typeof Image === "undefined") {
      resolve(null); // SSR / 非浏览器环境
      return;
    }
    const img = new Image();
    img.crossOrigin = "anonymous";
    img.onload = () => resolve(img);
    img.onerror = () => {
      // 失败不缓存:网络恢复后应当能重试,否则一次瞬时失败会让这张图这辈子都加载不出来。
      cache.delete(url);
      resolve(null);
    };
    img.src = url;
  });

  cache.set(url, task);
  return task;
}

/** 仅测试:清空解码缓存。 */
export function __clearSheetCache(): void {
  cache.clear();
}
