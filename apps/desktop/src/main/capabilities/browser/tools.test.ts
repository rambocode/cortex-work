import { beforeEach, describe, expect, it, vi } from "vitest";

// vi.hoisted:mock 工厂在 import 前求值,需用 hoisted 持可变态。
const h = vi.hoisted(() => ({
  guest: null as unknown,
  consoleBuf: [] as { level: number; message: string }[],
  approved: [] as string[],
  nav: "nonLocalOnly" as "nonLocalOnly" | "all",
}));

vi.mock("./guest-registry", () => ({
  getLiveGuest: () => h.guest,
  readConsoleBuffer: () => h.consoleBuf,
}));
vi.mock("../../ipc/store", () => ({
  getPersistedState: async () => ({
    generalSettings: { browserControl: { approvedOrigins: h.approved, navigationApproval: h.nav } },
  }),
}));
vi.mock("../../browser/localHtml", () => ({ isAuthorizedFileUrl: () => false }));

import { __resetOwnership } from "./ownership";
import { registerBrowserTools } from "./tools";
import { BROWSER_MCP_PLAN_TOOLS } from "@cortex-work/core/desktop/types";

type Handler = (args: Record<string, unknown>) => Promise<{ content: Array<Record<string, unknown>> }>;

function collectTools(sessionId: string | null = "s1", openPanel: (url: string) => void = () => {}): Map<string, Handler> {
  const handlers = new Map<string, Handler>();
  const mcp = { registerTool: (name: string, _cfg: unknown, cb: Handler) => handlers.set(name, cb) };
  registerBrowserTools(mcp as never, { sessionId }, { openPanel });
  return handlers;
}

function fakeGuest(execReturn: unknown = "ok") {
  return {
    loadURL: vi.fn(async () => {}),
    capturePage: vi.fn(async () => ({ toPNG: () => Buffer.from("PNG") })),
    executeJavaScript: vi.fn(async () => execReturn),
  };
}

describe("浏览器默认层工具（U5）", () => {
  beforeEach(() => {
    __resetOwnership();
    h.guest = null;
    h.consoleBuf = [];
    h.approved = [];
    h.nav = "nonLocalOnly";
  });

  it("无面板时回「无可控面板」", async () => {
    const r = await collectTools().get("browser_screenshot")!({});
    expect(String(r.content[0].text)).toContain("无可控");
  });

  it("navigate localhost → loadURL 被调", async () => {
    const g = fakeGuest();
    h.guest = g;
    const r = await collectTools().get("browser_navigate")!({ url: "http://localhost:3000" });
    expect(g.loadURL).toHaveBeenCalledWith("http://localhost:3000");
    expect(String(r.content[0].text)).toContain("已导航");
  });

  it("面板未开 → 请求 openPanel 并等 guest 出现后回「已打开」", async () => {
    h.guest = null;
    const openPanel = vi.fn((_url: string) => {
      h.guest = fakeGuest(); // 模拟渲染端开面板后 guest 出现
    });
    const r = await collectTools("s1", openPanel).get("browser_navigate")!({ url: "http://localhost:3000" });
    expect(openPanel).toHaveBeenCalledWith("http://localhost:3000");
    expect(String(r.content[0].text)).toContain("已打开");
  });

  it("navigate 非本地未授权 → 拒 + 提示授权,不调 loadURL", async () => {
    const g = fakeGuest();
    h.guest = g;
    const r = await collectTools().get("browser_navigate")!({ url: "https://evil.com" });
    expect(g.loadURL).not.toHaveBeenCalled();
    expect(String(r.content[0].text)).toContain("未授权");
  });

  it("navigationApproval=all:未授权本地导航被拒,加入白名单后放行(U5)", async () => {
    const g = fakeGuest();
    h.guest = g;
    h.nav = "all";
    const denied = await collectTools().get("browser_navigate")!({ url: "http://localhost:3000" });
    expect(g.loadURL).not.toHaveBeenCalled();
    expect(String(denied.content[0].text)).toContain("未授权");
    // 用户加入白名单后(模拟设置页写 approvedOrigins)→ 放行
    h.approved = ["http://localhost:3000"];
    await collectTools().get("browser_navigate")!({ url: "http://localhost:3000" });
    expect(g.loadURL).toHaveBeenCalledWith("http://localhost:3000");
  });

  it("KTD7 负向:浏览器 MCP 工具集不含任何写权限字段的工具(agent 不可自改授权)", () => {
    const names = [...collectTools().keys()];
    // 工具名须全部落在计划白名单内(新增工具须先进白名单,迫使评审)。
    for (const n of names) expect(BROWSER_MCP_PLAN_TOOLS).toContain(n);
    // 且无任何写设置 / 白名单 / CDP / 总开关的工具(只读 + 导航/点击/输入)。
    for (const n of names) expect(n).not.toMatch(/approve|origin|setting|config|cdp|enable|permission|authoriz/i);
  });

  it("screenshot → image content(base64 PNG)", async () => {
    h.guest = fakeGuest();
    const r = await collectTools().get("browser_screenshot")!({});
    expect(r.content[0].type).toBe("image");
    expect(r.content[0].mimeType).toBe("image/png");
    expect(r.content[0].data).toBe(Buffer.from("PNG").toString("base64"));
  });

  it("readDom → 不可信标注包裹文本", async () => {
    h.guest = fakeGuest("hello body");
    const r = await collectTools().get("browser_read_dom")!({});
    expect(String(r.content[0].text)).toContain("不可信网页");
    expect(String(r.content[0].text)).toContain("hello body");
  });

  it("click 未找到元素 → 提示", async () => {
    h.guest = fakeGuest("__CORTEX_NOT_FOUND__");
    const r = await collectTools().get("browser_click")!({ selector: "#x" });
    expect(String(r.content[0].text)).toContain("未找到");
  });

  it("归属:s1 占用时 s2 改动型工具被拒", async () => {
    h.guest = fakeGuest();
    await collectTools("s1").get("browser_navigate")!({ url: "http://localhost:3000" }); // s1 认领
    const r = await collectTools("s2").get("browser_navigate")!({ url: "http://localhost:3001" });
    expect(String(r.content[0].text)).toContain("占用");
  });

  // 漂移守卫:注册的浏览器工具名必须与 core 的 BROWSER_MCP_PLAN_TOOLS 逐一对应——后者并入 pi plan
  // 只读白名单(让默认 plan 会话也能用浏览器控制)。新增/改名工具忘了同步白名单 → 本测试红。
  it("注册的工具名与 BROWSER_MCP_PLAN_TOOLS 一致(plan 白名单漂移守卫)", () => {
    const registered = [...collectTools().keys()].sort();
    expect(registered).toEqual([...BROWSER_MCP_PLAN_TOOLS].sort());
  });
});
