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

// ── 尾部透明帧探测 ───────────────────────────────────────────────────────────
// **每行的有效帧数并不相同**,这是实测(ImageMagick 逐格量 alpha 均值)的硬事实:
// 8×9 的 petdex sprite 里,行 0/6/7/8 是 6 帧、行 1/2/5 是 8 帧,而
// **行 3(waving)只有 4 帧、行 4(jumping)只有 5 帧**,其余格子完全透明。
// 固定播 6 帧的后果:replying 落在行 3,每轮 6 帧里有 2 帧画的是空白——就是用户看到的
// 「agent 回复阶段偶尔宠物不见了」;happy 落在行 4 且是 oneShot,帧游标被钳在第 6 帧
// (透明),宠物会整整消失一次庆祝的时长。
// 故运行时探测:整图一次性缩绘到 (cols×PROBE)×(rows×PROBE),一次 getImageData 读回,
// 每格取 alpha 峰值判空,从右往左找到最后一个非空列即该行帧数。
// 之所以能读像素:cortex-petdex:// 注册了 corsEnabled + 响应带 ACAO,且 loadSheetImage
// 设了 crossOrigin="anonymous",canvas 不会被污染(见上面的注释)。

/** 每格缩绘成 PROBE×PROBE 像素——只需要知道有没有内容,不需要细节。 */
const PROBE = 4;
/** 判定「这一格有内容」的 alpha 阈值(缩绘插值会留个位数的杂值)。 */
const ALPHA_MIN = 8;

const rowFramesCache = new Map<string, readonly number[] | null>();

/**
 * 量出每行的有效帧数(去掉尾部全透明的格子)。按 url 缓存,一张图只量一次。
 * 环境不支持(jsdom 没有 canvas 2D / 图被污染)时返回 null,调用方退回固定帧数。
 */
export function measureRowFrames(
  url: string,
  img: HTMLImageElement,
  cellW: number,
  cellH: number,
): readonly number[] | null {
  const hit = rowFramesCache.get(url);
  if (hit !== undefined) return hit;

  const result = probeRowFrames(img, cellW, cellH);
  rowFramesCache.set(url, result);
  return result;
}

function probeRowFrames(img: HTMLImageElement, cellW: number, cellH: number): readonly number[] | null {
  if (typeof document === "undefined" || cellW < 1 || cellH < 1) return null;
  const cols = Math.floor(img.naturalWidth / cellW);
  const rows = Math.floor(img.naturalHeight / cellH);
  if (cols < 1 || rows < 1) return null;

  const canvas = document.createElement("canvas");
  canvas.width = cols * PROBE;
  canvas.height = rows * PROBE;
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  if (!ctx) return null;
  let data: Uint8ClampedArray;
  try {
    ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
    data = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
  } catch {
    return null; // 画布被污染 / jsdom 未实现:按「测不出来」处理,不影响显示
  }

  const frames: number[] = [];
  for (let row = 0; row < rows; row += 1) {
    let last = 0;
    for (let col = 0; col < cols; col += 1) {
      let peak = 0;
      for (let y = 0; y < PROBE; y += 1) {
        for (let x = 0; x < PROBE; x += 1) {
          const alpha = data[((row * PROBE + y) * canvas.width + (col * PROBE + x)) * 4 + 3] ?? 0;
          if (alpha > peak) peak = alpha;
        }
      }
      if (peak > ALPHA_MIN) last = col + 1; // 记最后一个有内容的列,中间的空格子不截断
    }
    frames.push(Math.max(1, last)); // 整行全空也至少留一帧,避免帧数为 0 除零
  }
  return frames;
}

/** 仅测试:清空解码缓存。 */
export function __clearSheetCache(): void {
  cache.clear();
  rowFramesCache.clear();
}
