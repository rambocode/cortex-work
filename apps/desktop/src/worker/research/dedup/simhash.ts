// 64 位 SimHash 与近重复聚簇（spec §12.4 的 duplicate cluster 环节）。
//
// 用途：同一篇稿子被多个站点转载时，Coverage 不能把它们算成多个独立来源。SHA-256 只能识别
// 「逐字相同」，转载往往带不同的导航残留与广告文案，必须用局部敏感哈希做近似判定。
//
// 特征选取复用 core 的 tokenizeRetrievalText（中英混合：拉丁词 + 汉字 2..4-gram），
// 这样中文转载也能被识别——按空格切词的方案对中文完全失效。
// 本文件是纯函数，跑在 utilityProcess Worker 里，禁止 import electron。
import { tokenizeRetrievalText } from "@cortex-work/core/retrieval/lexical";

/// 指纹位宽。改动它等于让历史 simhash 全部失效，必须同步清理已落库指纹。
const HASH_BITS = 64;

/// FNV-1a 64 位。选它是因为实现短、无依赖、分布够用；SimHash 只要求特征哈希均匀，
/// 不要求密码学强度（内容真伪由 SHA-256 的 contentHash 保证）。
function fnv1a64(text: string): bigint {
  let hash = 0xcbf29ce484222325n;
  const prime = 0x100000001b3n;
  const mask = 0xffffffffffffffffn;
  for (let i = 0; i < text.length; i += 1) {
    hash ^= BigInt(text.charCodeAt(i));
    hash = (hash * prime) & mask;
  }
  return hash;
}

/// 计算文本的 64 位 SimHash，输出 16 位小写十六进制（与协议的 simhash 字段一致）。
/// 词频作为权重：高频特征对指纹的影响更大，正文改一两个词不会翻转多少位。
export function simhashHex(text: string): string {
  const frequencies = new Map<string, number>();
  for (const token of tokenizeRetrievalText(text)) {
    frequencies.set(token, (frequencies.get(token) ?? 0) + 1);
  }

  const vector = new Array<number>(HASH_BITS).fill(0);
  for (const [token, weight] of frequencies) {
    const hash = fnv1a64(token);
    for (let bit = 0; bit < HASH_BITS; bit += 1) {
      const isSet = (hash >> BigInt(bit)) & 1n;
      vector[bit] = (vector[bit] ?? 0) + (isSet === 1n ? weight : -weight);
    }
  }

  let fingerprint = 0n;
  for (let bit = 0; bit < HASH_BITS; bit += 1) {
    if ((vector[bit] ?? 0) > 0) fingerprint |= 1n << BigInt(bit);
  }
  return fingerprint.toString(16).padStart(16, "0");
}

/// 把十六进制指纹解析成 bigint；非法输入返回 null（调用方按「最大距离」处理）。
function parseHex(hex: string): bigint | null {
  if (!/^[0-9a-fA-F]{1,16}$/.test(hex)) return null;
  return BigInt(`0x${hex}`);
}

/// 两个指纹的汉明距离（不同位的个数）。任一侧非法时返回 HASH_BITS，即「肯定不是重复」，
/// 保证坏数据只会漏判重复、不会误判成重复而吞掉一个独立来源。
export function hammingDistance(a: string, b: string): number {
  const left = parseHex(a);
  const right = parseHex(b);
  if (left === null || right === null) return HASH_BITS;
  let diff = left ^ right;
  let count = 0;
  while (diff !== 0n) {
    diff &= diff - 1n;
    count += 1;
  }
  return count;
}

/// 一个近重复簇：代表 + 其余成员。代表取输入顺序中的首个成员（调用方应把最可信的排前面）。
export interface HammingCluster {
  representativeId: string;
  memberIds: string[];
}

/// 贪心聚簇：按输入顺序扫描，未归簇的项与已存在的簇代表比对，距离 ≤ threshold 即并入。
///
/// 为什么是贪心而不是完整的传递闭包：距离不满足传递性（a~b、b~c 不蕴含 a~c），完整聚类需要
/// O(n²) 且结果依赖遍历顺序；抓取批次规模只有几十篇，贪心的误差可以接受，且结果稳定可测。
/// 注意本实现会把「与代表接近」的项并入——所以 a~b、b~c 但 a 与 c 距离略大时，仍会因为都靠近
/// 代表 a 而同簇（见测试中的传播性用例）。
export function clusterByHamming(
  items: ReadonlyArray<{ id: string; hash: string }>,
  threshold = 3,
): HammingCluster[] {
  const clusters: HammingCluster[] = [];
  const assigned = new Set<string>();

  for (let i = 0; i < items.length; i += 1) {
    const item = items[i];
    if (!item || assigned.has(item.id)) continue;
    const members: string[] = [];
    for (let j = i + 1; j < items.length; j += 1) {
      const other = items[j];
      if (!other || assigned.has(other.id)) continue;
      if (hammingDistance(item.hash, other.hash) <= threshold) {
        members.push(other.id);
        assigned.add(other.id);
      }
    }
    if (members.length > 0) {
      assigned.add(item.id);
      clusters.push({ representativeId: item.id, memberIds: members });
    }
  }

  return clusters;
}
