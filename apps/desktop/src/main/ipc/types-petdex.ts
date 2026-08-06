// petdex 公共宠物图鉴的 IPC 契约。
// ⚠️ 与 packages/core/desktop/petdex-types.ts 逐字镜像(core 不能依赖 app 包,两侧各持一份)。
// 单独成文件而不并进 ipc/types.ts:后者已 1587 行,远超单文件 1200 行上限,只能减不能加。

/**
 * 瘦身后的图鉴条目。
 * 刻意丢弃上游 manifest 的 submittedBy / petJsonUrl / zipUrl:
 * petJson 实测只有 {id, displayName, description, spritesheetPath},**不含帧布局**,
 * 对渲染零价值(参考实现 hermes-studio 把它下载存盘却从不解析——别抄)。
 * 4374 条 × 约 100B ≈ 420KB,一次 IPC 传完可接受。
 */
export interface PetdexEntry {
  slug: string;
  displayName: string;
  kind: "character" | "creature" | "object";
  spritesheetUrl: string;
}

export interface PetdexManifestResult {
  pets: PetdexEntry[];
  total: number;
  /** 这份数据的抓取时刻(毫秒)。 */
  fetchedAt: number;
  /** true = 网络失败,返回的是磁盘旧副本,UI 需提示「离线」。 */
  stale: boolean;
}

/**
 * 一只已落盘 sprite 的描述符。
 * cols/rows 由主进程解析 WebP 头部得出(不解码像素),渲染端直接用,不必二次探测。
 */
export interface PetdexSpriteRef {
  slug: string;
  displayName: string;
  /** cortex-petdex://sprite/<slug>.webp?v=<revision>;渲染端只当它是普通图片 URL。 */
  url: string;
  width: number;
  height: number;
  cols: number;
  rows: number;
  bytes: number;
}

export interface PetdexCacheStats {
  entries: number;
  bytes: number;
}

/**
 * 当前该渲染哪张 sprite(搭 pet:sync-state 的顺风车广播给 overlay,故也属于本契约)。
 *
 * 两种来源共存是刻意的取舍:内置角色随包发布、离线与首启必定可用(宠物是常驻装饰,
 * 第一次打开应用时往往网络还没配好,那时右下角不该是一片空白);petdex 是增值扩展。
 * 网格布局也因此不同——内置资产是单行横排(rows=1),petdex 是 cols×rows 二维网格,
 * 渲染器用同一套 (col,row) 取帧逻辑覆盖两者,不需要两条渲染路径。
 */
export interface PetSpriteSource {
  origin: "builtin" | "petdex";
  /** builtin → PetKind;petdex → slug。 */
  id: string;
  /** 资产 URL。builtin 为 null——它由 views 侧的 ESM import 解析,
   * 跨打包器返回形状不同(Vite 给字符串、Next 给对象),不能穿过 IPC。 */
  url: string | null;
  cols: number;
  rows: number;
  displayName: string;
}
