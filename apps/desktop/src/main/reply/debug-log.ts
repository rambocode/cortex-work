// reply 调试记录环形缓冲（U7 / R14）：最近 20 次模型调用的输入输出，**仅内存驻留**，
// 应用退出即清（KTD8 隐私边界：对话原文 / OCR 原文 / prompt 一律不落盘）。
//
// 每条记录含捕获来源、AX 原文、OCR 原文、system+user prompt、以及输出或错误，供设置页
// 调试面板（U9）展开排查候选质量与清洗规则。

import type { ReplyDebugEntry } from "../ipc/reply-types";

/** 环形缓冲上限（源项目常量：最近 20 条）。 */
export const REPLY_DEBUG_LIMIT = 20;

/**
 * 定长环形缓冲。新记录插到头部（list() 天然「最新在前」），超上限时丢弃最旧的一条。
 * 纯内存、无持久化调用——单测可直接断言淘汰行为与错误分支。
 */
export class ReplyDebugLog {
  private entries: ReplyDebugEntry[] = [];

  constructor(private readonly limit = REPLY_DEBUG_LIMIT) {}

  /** 追加一条记录（最新在前）；超上限时截断尾部（最旧）。 */
  add(entry: ReplyDebugEntry): void {
    this.entries.unshift(entry);
    if (this.entries.length > this.limit) {
      this.entries.length = this.limit;
    }
  }

  /** 返回当前全部记录的副本（最新在前），供 IPC 透出给渲染端。 */
  list(): ReplyDebugEntry[] {
    return [...this.entries];
  }

  /** 清空（数据清理 / 测试复位用）。 */
  clear(): void {
    this.entries = [];
  }
}

// 进程级单例：controller 写入、ipc/reply.ts 的 reply:getDebugLog 读取（同一份内存缓冲）。
export const replyDebugLog = new ReplyDebugLog();
