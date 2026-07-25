// hello：握手（spec §12.1）。
//
// 契约要点：Worker 回报的 max_protocol_version 是 main 判断「能不能继续发业务请求」的唯一依据；
// 版本闸的另一半（main 请求版本 > Worker 支持）在 rpc-server.handleHello 里。
// 本文件跑在 utilityProcess Worker 里，禁止 import electron。
import { RESEARCH_PROTOCOL_VERSION, WORKER_METHODS } from "@cortex-work/core/research/protocol";
import type { HelloParams, HelloResult } from "../rpc-server";

/// 握手所需的运行时事实，由 index.ts 注入（便于测试与将来的能力探测扩展）。
export interface HelloDeps {
  workerVersion: string;
  /// agent-browser 是否可用。首版由 main 通过 doctor/fetch_prepare 的参数告知，
  /// Worker 自身在握手阶段还不知道路径，故通常为 false。
  browserAvailable: boolean;
}

/// 处理 hello 请求。params 目前只用于版本判定（在 rpc-server 里完成），此处保留形参以便
/// 将来按 desktop_version 做兼容分支。
export function runHello(_params: HelloParams, deps: HelloDeps): HelloResult {
  return {
    worker_version: deps.workerVersion,
    max_protocol_version: RESEARCH_PROTOCOL_VERSION,
    methods: [...WORKER_METHODS],
    browser_available: deps.browserAvailable,
  };
}
