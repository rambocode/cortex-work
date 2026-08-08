// 语音助手控制工具的契约测试:工具注册面、执行面门控(未激活即拒绝)、注入配置门控。
// HTTP 端到端范式抄 delegate/server.test.ts(真 host + initialize→tools/list→tools/call)。
import { afterEach, describe, expect, it, vi } from "vitest";
import http from "node:http";

import {
  VOICE_ASSISTANT_TOOLS,
  buildVoiceAssistantMcpServerConfig,
  setVoiceAssistantIntentDispatcher,
  startVoiceAssistantToolsHost,
  stopVoiceAssistantToolsHost,
} from "./assistant-tools";

// 动作下发器经 setter 注入(生产装配在 registerVoiceAssistantHandlers),单测注入可控 mock。
const dispatchMock = vi.fn();
setVoiceAssistantIntentDispatcher((intent) => dispatchMock(intent) as boolean);

afterEach(() => {
  stopVoiceAssistantToolsHost();
  dispatchMock.mockReset();
});

function post(cfg: { url: string; headers?: Record<string, string> }, body: unknown) {
  return new Promise<{ status: number; body: string }>((resolve, reject) => {
    const u = new URL(cfg.url);
    const r = http.request(
      {
        hostname: u.hostname,
        port: Number(u.port),
        path: u.pathname,
        method: "POST",
        headers: { ...(cfg.headers ?? {}), "content-type": "application/json", accept: "application/json, text/event-stream" },
      },
      (res) => {
        let d = "";
        res.setEncoding("utf8");
        res.on("data", (c) => (d += c));
        res.on("end", () => resolve({ status: res.statusCode || 0, body: d }));
      },
    );
    r.on("error", reject);
    r.write(JSON.stringify(body));
    r.end();
  });
}

async function startAndHandshake(sessionId: string) {
  await startVoiceAssistantToolsHost();
  const cfg = buildVoiceAssistantMcpServerConfig(sessionId) as { url: string; headers?: Record<string, string> };
  expect(cfg).not.toBeNull();
  const init = await post(cfg, {
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t", version: "1" } },
  });
  expect(init.status).toBe(200);
  return cfg;
}

describe("voice-assistant 控制工具", () => {
  it("tools/list 返回语音控制工具(darwin 含屏幕上下文一对)", async () => {
    const cfg = await startAndHandshake("va-list");
    const list = await post(cfg, { jsonrpc: "2.0", id: 2, method: "tools/list", params: {} });
    expect(list.status).toBe(200);
    expect(list.body).toContain("voice_exit_assistant");
    expect(list.body).toContain("voice_new_conversation");
    if (process.platform === "darwin") {
      expect(list.body).toContain("voice_enable_screen_context");
      expect(list.body).toContain("voice_disable_screen_context");
    }
  });

  it("语音激活时 tools/call 下发对应本地动作并返回引导文案", async () => {
    dispatchMock.mockReturnValue(true);
    const cfg = await startAndHandshake("va-call");
    const call = await post(cfg, {
      jsonrpc: "2.0",
      id: 3,
      method: "tools/call",
      params: { name: "voice_exit_assistant", arguments: {} },
    });
    expect(call.status).toBe(200);
    expect(dispatchMock).toHaveBeenCalledWith("exit_assistant");
    expect(call.body).toContain("已安排退出");
  });

  it("语音未激活时 tools/call 返回可读错误,不产生任何动作(执行面门控)", async () => {
    dispatchMock.mockReturnValue(false);
    const cfg = await startAndHandshake("va-gate");
    const call = await post(cfg, {
      jsonrpc: "2.0",
      id: 4,
      method: "tools/call",
      params: { name: "voice_exit_assistant", arguments: {} },
    });
    expect(call.status).toBe(200);
    expect(call.body).toContain("语音助手当前未激活");
    expect(call.body).toContain("isError");
  });

  it("注入配置门控:无 sessionId / host 未起 → null", async () => {
    expect(buildVoiceAssistantMcpServerConfig(undefined)).toBeNull();
    // host 未启动(afterEach 已 stop)时同样不给出连不上的 url。
    expect(buildVoiceAssistantMcpServerConfig("s")).toBeNull();
  });

  it("工具清单与意图一一对应(名字进模型上下文,契约固化防手滑)", () => {
    expect(VOICE_ASSISTANT_TOOLS.map((t) => [t.name, t.intent])).toEqual([
      ["voice_exit_assistant", "exit_assistant"],
      ["voice_new_conversation", "new_conversation"],
      ["voice_enable_screen_context", "enable_screen_context"],
      ["voice_disable_screen_context", "disable_screen_context"],
    ]);
  });
});
