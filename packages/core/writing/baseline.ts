// 写作工作区「磁盘基线」模块:每个打开文件维护「上次加载/保存时的磁盘内容快照 + hash」。
// 一份数据两用(KTD「磁盘基线一份数据两用」):
//   ① 外部改动判定的对照 —— 盘上内容 vs 基线,判断文件是否被 agent/外部程序改过;
//   ② diff 审阅(U6)的「旧版」—— beginDiffReview(基线, 盘上新内容)。
//
// 为什么放模块级 Map(key=绝对路径)而不放组件 state:归因(U9)可能在写作覆盖层关闭、
// 编辑器组件已卸载后仍收到 agent 写盘信号并需要读取基线,故基线必须脱离组件生命周期常驻。
// core 跨端(Web/Desktop)不得依赖 node crypto,故 hash 用纯函数自实现。

export interface FileBaseline {
  // 建立基线时刻的磁盘内容全文。
  content: string;
  // content 的确定性 hash(回声比对与快速去重用)。
  hash: string;
}

// FNV-1a 32-bit 字符串 hash:确定性、无外部依赖、对大文本足够快。
// 仅用于「是否相同」的去重/回声判定,非密码学用途,碰撞风险可忽略。
export function hashContent(content: string): string {
  let h = 0x811c9dc5; // FNV offset basis
  for (let i = 0; i < content.length; i++) {
    h ^= content.charCodeAt(i);
    // 乘以 FNV prime(0x01000193),用移位组合避免 32 位溢出丢精度。
    h = (h + ((h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24))) >>> 0;
  }
  return h.toString(16).padStart(8, "0");
}

// 当前所有打开/审阅中文件的磁盘基线(key=绝对路径)。
const baselines = new Map<string, FileBaseline>();
// 自写回声抑制:记录本端自动保存最近一次写盘的内容 hash(key=绝对路径)。
// watch 的 dirChanged 会把我们自己的写盘也回声一次;比对命中即判为自身回声,忽略。
const selfWriteHashes = new Map<string, string>();

// 建立/更新某文件基线(加载成功、保存成功、裁决落盘后调用)。返回新基线便于调用方复用 hash。
export function setBaseline(path: string, content: string): FileBaseline {
  const bl: FileBaseline = { content, hash: hashContent(content) };
  baselines.set(path, bl);
  return bl;
}

// 读取某文件基线;未建立时返回 undefined(调用方据此判断「尚无对照」)。
export function getBaseline(path: string): FileBaseline | undefined {
  return baselines.get(path);
}

// 清除某文件的基线与自写记录(文件关闭/删除时调用,避免 Map 无界增长与陈旧对照)。
export function clearBaseline(path: string): void {
  baselines.delete(path);
  selfWriteHashes.delete(path);
}

// 记录一次「本端自写」的内容 hash(自动保存写盘成功后调用),供后续 dirChanged 回声抑制。
export function recordSelfWrite(path: string, content: string): void {
  selfWriteHashes.set(path, hashContent(content));
}

// 判断给定(盘上重读的)内容是否为本端最近一次自写的回声。
// 持久语义:不消费记录 —— watch 去抖可能对同一次写盘多次回声,持久比对都能命中;
// 且若外部改动恰好等于我们上次所写内容,盘面与基线本就一致、无可视 diff,忽略亦无害。
export function isSelfEcho(path: string, content: string): boolean {
  const h = selfWriteHashes.get(path);
  return h != null && h === hashContent(content);
}

// 测试隔离用:清空模块级 Map,避免用例间串场。仅供单测 beforeEach 调用。
export function __resetWritingBaselines(): void {
  baselines.clear();
  selfWriteHashes.clear();
}
