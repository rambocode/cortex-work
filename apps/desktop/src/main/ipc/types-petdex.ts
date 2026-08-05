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
