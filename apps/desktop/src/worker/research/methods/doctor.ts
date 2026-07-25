// doctor：Worker 自检（spec §12.1）。
//
// 用途只有一个——把结果展示在设置页给用户看。**issues 是自由文本，不参与任何自动化判定**
// （协议注释里已写死这一点）：一旦让 main 按文本分支决策，措辞改动就会变成行为改动。
//
// 三项探测都是注入函数，因此单测不需要真的装 Node / pdfjs / agent-browser。
// 本文件跑在 utilityProcess Worker 里，禁止 import electron。
import { accessSync, constants } from "node:fs";
import type { DoctorParams, DoctorResult } from "../rpc-server";
import { loadPdfJs } from "../extract/pdf";

/// Worker 要求的最低 Node 大版本。Electron 39 内嵌 Node 22（U0 spike 实测），低于 20 说明
/// 运行环境不是我们预期的宿主，抓取与解析的行为都不可保证。
const MIN_NODE_MAJOR = 20;

/// 自检所需的环境探测，全部可注入。
export interface DoctorDeps {
  nodeVersion?: string;
  /// pdfjs 能否加载。真实实现是尝试 import 一次 legacy build。
  probePdf?: () => Promise<boolean>;
  /// 判断二进制是否存在且可执行。
  canExecute?: (path: string) => boolean;
}

/// 默认的 pdfjs 探测：真的加载一次。加载后模块会被缓存，后续抓取不再付第二次成本。
async function defaultProbePdf(): Promise<boolean> {
  const pdfjs = await loadPdfJs();
  return typeof pdfjs.getDocument === "function";
}

/// 默认的可执行判定：X_OK 检查（存在但没有执行位同样算不可用）。
function defaultCanExecute(path: string): boolean {
  try {
    accessSync(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/// 解析 "v22.22.1" / "22.22.1" 的大版本号。
function nodeMajor(version: string): number {
  const match = /^v?(\d+)/.exec(version.trim());
  return match ? Number.parseInt(match[1]!, 10) : 0;
}

/// 执行自检。任何一项探测抛错都等价于「该项不可用」，绝不让自检本身失败——
/// 自检失败会让用户完全看不到问题在哪，比报告一个 false 更糟。
export async function runDoctor(params: DoctorParams, deps: DoctorDeps = {}): Promise<DoctorResult> {
  const issues: string[] = [];
  const nodeVersion = deps.nodeVersion ?? process.version;

  if (nodeMajor(nodeVersion) < MIN_NODE_MAJOR) {
    issues.push(`Node 版本过低（${nodeVersion}），需要 ${MIN_NODE_MAJOR} 及以上`);
  }

  let pdfAvailable = false;
  try {
    pdfAvailable = await (deps.probePdf ?? defaultProbePdf)();
  } catch {
    pdfAvailable = false;
  }
  if (!pdfAvailable) issues.push("PDF 解析不可用（pdfjs 加载失败），PDF 来源将被跳过");

  // main 没下发路径时不算问题：Browser 降级本就是可选能力（额度有限、成本高）。
  let browserAvailable = false;
  if (params.agent_browser_binary) {
    browserAvailable = (deps.canExecute ?? defaultCanExecute)(params.agent_browser_binary);
    if (!browserAvailable) {
      issues.push(`agent-browser 不可执行：${params.agent_browser_binary}`);
    }
  }

  return {
    ok: issues.length === 0,
    node_version: nodeVersion,
    browser_available: browserAvailable,
    pdf_available: pdfAvailable,
    issues,
  };
}
