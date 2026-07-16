// 回归:pi 的 MCP 桥接必须把本轮所有 server 合并进**一个**扩展文件。
//
// 背景(实测踩出):pi 的工具去重只在单个扩展内生效(bridge runtime 的 registered 集合
// 是每文件一份)。design-delegate 与 cortex-slides 各写一个扩展时,两边都注册 ping,
// pi 直接报:
//   Error: Failed to load extension "…/slides-bridge-…js": Tool "ping" conflicts with "…"
// 导致后加载的 slides 扩展整体挂不上 —— pi 下 slides 工具全部丢失。
// 合并成一个扩展后,由 bridge 内部 registered 去重,两个 server 都能连上(已用真实 pi 验证)。
import { Script } from "node:vm";
import { describe, expect, it } from "vitest";
import { renderMcpBridgeExtension, type BridgeServer } from "./pi-mcp-bridge";

const DESIGN_DELEGATE: BridgeServer = {
  id: "cortex-design-delegate",
  transport: "http",
  url: "http://127.0.0.1:57480/mcp",
  headers: { Authorization: "Bearer aaa", "X-Cortex-Session": "design-doc1" },
};
const SLIDES: BridgeServer = {
  id: "cortex-slides",
  transport: "http",
  url: "http://127.0.0.1:57526/mcp",
  headers: { Authorization: "Bearer bbb", "X-Cortex-Session": "design-doc1" },
};

describe("多 server 合并进单个 pi 扩展", () => {
  const src = renderMcpBridgeExtension([DESIGN_DELEGATE, SLIDES]);

  it("一个扩展内烘焙两个 server(而非分文件,避免 ping 工具跨扩展冲突)", () => {
    expect(src).toContain(`const SERVERS = ${JSON.stringify([DESIGN_DELEGATE, SLIDES])};`);
    expect(src).toContain("cortex-design-delegate");
    expect(src).toContain("cortex-slides");
    // 单个 default export:pi 一个文件一个扩展。
    expect((src.match(/export default/g) ?? []).length).toBe(1);
  });

  it("跨 server 同名工具由扩展内部去重(先到先得),不会抛冲突", () => {
    // bridge runtime 内的去重守卫必须在(它是 ping 不冲突的唯一依据)。
    expect(src).toContain("registered.has(t.name)");
    expect(src).toContain("registered.add(t.name)");
  });

  it("生成源码语法有效", () => {
    const body = src
      .split("\n")
      .filter((l) => !l.startsWith("import ") && !l.startsWith("export default"))
      .join("\n");
    expect(() => new Script(body)).not.toThrow();
  });
});
