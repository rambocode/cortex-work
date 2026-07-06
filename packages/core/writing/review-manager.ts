// 写作工作区 diff 审阅子系统(U6):模块级 per-file「待审阅」表 + 纯行级 diff/合成引擎。
//
// 为什么放模块级(zustand standalone,非组件 state):agent 可能在写作覆盖层关闭、编辑器组件
// 已卸载后仍写盘并触发审阅入队(见 KTD「审阅态集中在模块级 review-manager」);pending 必须
// 脱离组件生命周期常驻,重进覆盖层/切回文件才能恢复审阅。故用模块级 store(key=绝对路径)。
//
// 数据模型:每个待审阅文件持有 { baseline(旧版=diff original), next(新版=盘上/agent 新内容) }。
//   - agent 同回合再写同一文件:只换 next、baseline 不动(refreshNext / beginReview 幂等收口);
//   - 裁决落盘:resolveWritingReview 写盘 → 推进磁盘基线 → 记自写 hash 抑制回声 → 清 pending(解冻)。
//
// 纯行级 diff/合成引擎(computeLineDiff/synthesizeLineDiff):供「逐块接受/拒绝」的确定性合成
// 与 @codemirror/merge 动态加载失败时的降级裁决使用,且可脱离 CodeMirror 单测(KTD6 双打包约束下
// CM 相关包只能动态 import,不能进核心逻辑)。全接受=next、全拒绝=baseline 由段覆盖不变量保证。

import { create } from "zustand";
import { recordSelfWrite, setBaseline } from "./baseline";

// 审阅入口来源:agent 改稿写盘,或外部脏冲突(基线=编辑器当前内容、新版=盘上内容,复用同一通道)。
export type ReviewOrigin = "agent" | "conflict";

// 单个文件的待审阅记录(key=绝对路径)。
export interface PendingReview {
  path: string;
  // 旧版(diff 的 original):agent 写盘时刻的编辑器内容 / 外部冲突时的编辑器当前内容。
  baseline: string;
  // 新版(diff 的 modified):盘上被 agent/外部改成的内容。
  next: string;
  origin: ReviewOrigin;
}

interface WritingReviewState {
  // 当前所有待审阅文件(绝对路径 → 记录)。空对象表示无挂起审阅。
  pending: Record<string, PendingReview>;
  // 进入/刷新审阅。next===有效基线(无 diff)时不入队并返回 false;
  // 已存在 pending 时保留原 baseline(agent 再写只换新版),忽略入参 baseline。返回是否处于审阅态。
  beginReview: (input: {
    path: string;
    baseline: string;
    next: string;
    origin: ReviewOrigin;
  }) => boolean;
  // agent 审阅态再写同一文件:仅替换新版、基线不动;新版回到基线则清除审阅。
  refreshNext: (path: string, next: string) => void;
  // 清除某文件审阅(裁决完毕 / agent 撤回到基线)。
  clearReview: (path: string) => void;
  // 清空全部(切换 workspace 语义暂不用,保留给测试与彻底重置)。
  clearAll: () => void;
}

export const useWritingReviewStore = create<WritingReviewState>((set, get) => ({
  pending: {},

  beginReview: ({ path, baseline, next, origin }) => {
    const existing = get().pending[path];
    // 审阅态再写:锁定首次基线,避免把用户尚未裁决的中间版本当作新对照。
    const effectiveBaseline = existing ? existing.baseline : baseline;
    if (next === effectiveBaseline) {
      // 新版与基线相同 → 无可视 diff。已有 pending(agent 改回原样)则收口,否则不进审阅。
      if (existing) get().clearReview(path);
      return false;
    }
    set((s) => ({
      pending: {
        ...s.pending,
        [path]: { path, baseline: effectiveBaseline, next, origin: existing?.origin ?? origin },
      },
    }));
    return true;
  },

  refreshNext: (path, next) => {
    const existing = get().pending[path];
    if (!existing) return; // 未在审阅态,忽略(应走 beginReview 入队)
    if (next === existing.baseline) {
      get().clearReview(path);
      return;
    }
    set((s) => ({ pending: { ...s.pending, [path]: { ...existing, next } } }));
  },

  clearReview: (path) =>
    set((s) => {
      if (!(path in s.pending)) return {};
      const rest = { ...s.pending };
      delete rest[path];
      return { pending: rest };
    }),

  clearAll: () => set({ pending: {} }),
}));

// 便捷读取(组件外/命令式调用):当前文件是否在审阅态。
export function getPendingReview(path: string): PendingReview | undefined {
  return useWritingReviewStore.getState().pending[path];
}

// 便捷读取:全部待审阅文件路径(WritingSidebar 徽标兜底用;组件内应订阅 store 以获响应式更新)。
export function listPendingReviewPaths(): string[] {
  return Object.keys(useWritingReviewStore.getState().pending);
}

// 裁决落盘:把用户选定内容写盘 → 推进磁盘基线 → 记自写 hash(抑制本次落盘的 watch 自回声)→
// 清 pending(解冻编辑器/自动保存)。persist 抛错则保留 pending 供重试并向上抛出。
// 落盘经调用方注入的 persist(避免 core 依赖 DesktopBridge 具体实现;与 baseline 模块同为纯回调式)。
export async function resolveWritingReview(
  path: string,
  acceptedContent: string,
  persist: (path: string, content: string) => Promise<void>,
): Promise<void> {
  await persist(path, acceptedContent);
  setBaseline(path, acceptedContent);
  recordSelfWrite(path, acceptedContent);
  useWritingReviewStore.getState().clearReview(path);
}

// ── 纯行级 diff/合成引擎 ─────────────────────────────────────────────────
// diff 段:common(两侧一致,原样输出)/ chunk(差异块,含基线侧 base 行与新版侧 next 行)。
export type DiffSegment =
  | { type: "common"; lines: string[] }
  | { type: "chunk"; index: number; base: string[]; next: string[] };

export interface LineDiff {
  segments: DiffSegment[];
  // 差异块数量(逐块裁决的 decisions 长度)。
  chunkCount: number;
}

// 逐块裁决:accept=采用新版行、reject=保留基线行。
export type ChunkDecision = "accept" | "reject";

// 按行切分(保留全部行,含空串)。join 以 "\n" 回拼,保证 split→join 恒等还原原文。
function splitLines(text: string): string[] {
  return text.split("\n");
}

// LCS 长度矩阵(自底向上):dp[i][j] = a[i..] 与 b[j..] 的最长公共子序列长度。
function lcsMatrix(a: string[], b: string[]): number[][] {
  const m = a.length;
  const n = b.length;
  const dp: number[][] = Array.from({ length: m + 1 }, () => new Array<number>(n + 1).fill(0));
  for (let i = m - 1; i >= 0; i--) {
    // 行索引在界内(i∈[0,m-1]、i+1≤m),取非空行引用(noUncheckedIndexedAccess 下需显式收窄)。
    const row = dp[i] as number[];
    const rowNext = dp[i + 1] as number[];
    for (let j = n - 1; j >= 0; j--) {
      row[j] =
        a[i] === b[j]
          ? (rowNext[j + 1] as number) + 1
          : Math.max(rowNext[j] as number, row[j + 1] as number);
    }
  }
  return dp;
}

// 计算基线→新版的行级 diff,产出有序段序列。
// 不变量:全 accept 合成 === 新版、全 reject 合成 === 基线(段覆盖两侧全部行,顺序保持)。
export function computeLineDiff(baseline: string, next: string): LineDiff {
  const a = splitLines(baseline);
  const b = splitLines(next);
  const dp = lcsMatrix(a, b);
  const segments: DiffSegment[] = [];
  let i = 0;
  let j = 0;
  let chunkIndex = 0;
  // 累积当前差异块的两侧行,遇到公共行或走完时收口成一个 chunk 段。
  let pendBase: string[] = [];
  let pendNext: string[] = [];
  const flushChunk = (): void => {
    if (pendBase.length || pendNext.length) {
      segments.push({ type: "chunk", index: chunkIndex++, base: pendBase, next: pendNext });
      pendBase = [];
      pendNext = [];
    }
  };
  const pushCommon = (line: string): void => {
    const last = segments[segments.length - 1];
    // 连续公共行并入同一 common 段,减少段数(逐块裁决更贴合直觉)。
    if (last && last.type === "common") last.lines.push(line);
    else segments.push({ type: "common", lines: [line] });
  };
  while (i < a.length && j < b.length) {
    // 循环条件已保证 i/j 在界内,取非空局部值(noUncheckedIndexedAccess 下需显式收窄)。
    const ai = a[i] as string;
    const bj = b[j] as string;
    if (ai === bj) {
      flushChunk();
      pushCommon(ai);
      i++;
      j++;
    } else {
      const rowNext = dp[i + 1] as number[];
      const rowCur = dp[i] as number[];
      // 保留 a[i] 更优(或等价):判为基线删除,归入当前 chunk 的 base 侧;否则新版插入。
      if ((rowNext[j] as number) >= (rowCur[j + 1] as number)) {
        pendBase.push(ai);
        i++;
      } else {
        pendNext.push(bj);
        j++;
      }
    }
  }
  while (i < a.length) pendBase.push(a[i++] as string);
  while (j < b.length) pendNext.push(b[j++] as string);
  flushChunk();
  return { segments, chunkCount: chunkIndex };
}

// 按逐块裁决合成最终文本。decisions[index] 缺省视为 "accept"(未裁决块默认采用新版)。
export function synthesizeLineDiff(diff: LineDiff, decisions: ChunkDecision[]): string {
  const out: string[] = [];
  for (const seg of diff.segments) {
    if (seg.type === "common") {
      out.push(...seg.lines);
    } else {
      const decision = decisions[seg.index] ?? "accept";
      out.push(...(decision === "accept" ? seg.next : seg.base));
    }
  }
  return out.join("\n");
}

// 测试隔离:清空模块级审阅表,避免用例间串场。仅供单测 beforeEach 调用。
export function __resetWritingReviews(): void {
  useWritingReviewStore.setState({ pending: {} });
}
