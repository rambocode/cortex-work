import { beforeEach, describe, expect, it, vi } from "vitest";

// vi.hoisted:mock 工厂在 import 前求值,需用 hoisted 持可变态。
const h = vi.hoisted(() => ({
  guest: null as unknown,
  consoleBuf: [] as { level: number; message: string }[],
  approved: [] as string[],
}));

vi.mock("./guest-registry", () => ({
  getLiveGuest: () => h.guest,
  readConsoleBuffer: () => h.consoleBuf,
}));
vi.mock("../ipc/store", () => ({
  getPersistedState: async () => ({ generalSettings: { browserControl: { approvedOrigins: h.approved } } }),
}));
vi.mock("../browser/localHtml", () => ({ isAuthorizedFileUrl: () => false }));

import { __resetOwnership } from "./ownership";
import { registerBrowserTools } from "./tools";

type Handler = (args: Record<string, unknown>) => Promise<{ content: Array<Record<string, unknown>> }>;

function collectTools(sessionId: string | null = "s1"): Map<string, Handler> {
  const handlers = new Map<string, Handler>();
  const mcp = { registerTool: (name: string, _cfg: unknown, cb: Handler) => handlers.set(name, cb) };
  registerBrowserTools(mcp as never, { sessionId });
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

  it("navigate 非本地未授权 → 拒 + 提示授权,不调 loadURL", async () => {
    const g = fakeGuest();
    h.guest = g;
    const r = await collectTools().get("browser_navigate")!({ url: "https://evil.com" });
    expect(g.loadURL).not.toHaveBeenCalled();
    expect(String(r.content[0].text)).toContain("未授权");
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
});
