// 装配层的接线断言。
//
// 为什么需要这个文件：ResearchService 的可选依赖全部是 `?:`，漏传一个不会有任何编译错误，
// 也不会让任何单测变红——因为单测都自己构造 deps。真实后果只在生产里显现：
// **Browser 兜底整条路径变成死代码**（403/429/空正文的站点永远救不回来），
// 而 fetch-prepare 的单测依然全绿，因为它们直接传了 agent_browser_binary。
//
// 这里不启动 Electron，只对 runtime.ts 的源码做结构断言：装配点必须把这些依赖接上。
// 断言源码文本很粗糙，但它能咬住「有没有接线」这件事，而这正是漏掉的那一环。
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const runtimeSource = readFileSync(join(__dirname, "runtime.ts"), "utf8");

describe("runtime.ts 的 ResearchService 装配", () => {
  /// agentBrowserBinary 缺席时，worker 侧的 tryBrowserFallback 会在
  /// `if (!binary ...) return null` 处直接放弃——知乎这类 403 站点因此永远抓不到。
  it("必须注入 agentBrowserBinary，否则 Browser 兜底是死代码", () => {
    expect(runtimeSource).toContain("agentBrowserBinary");
  });

  it("agentBrowserBinary 走公用的 resolveAgentBrowserBinary，不另写一套路径推断", () => {
    expect(runtimeSource).toContain("resolveAgentBrowserBinary");
  });

  /// reportArchive 缺席时研究照跑照完成，只是报告永远不落到项目目录——
  /// 与 agentBrowserBinary 同类的「静默失效」，单测全绿也发现不了。
  it("必须注入 reportArchive，否则报告永远不会落到项目目录", () => {
    expect(runtimeSource).toContain("reportArchive");
    expect(runtimeSource).toContain("archiveResearchReport");
  });

  /// 路径解析必须留在装配层：service 只拿 projectId，
  /// 一旦有人把路径提到 IPC 入参里，这条断言就该连同 schema 测试一起响。
  it("项目路径由装配层按 id 解析，不从入参接收", () => {
    expect(runtimeSource).toContain("resolveProjectPath");
  });
});
