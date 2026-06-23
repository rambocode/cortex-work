import { beforeEach, describe, expect, it } from "vitest";

import { __resetCdpState, ingestCdpEvent, readNetwork, redactHeaders } from "./cdp";

describe("CDP 网络脱敏与缓冲（U7）", () => {
  beforeEach(() => __resetCdpState());

  it("redactHeaders 脱敏敏感头(大小写不敏感),保留其它", () => {
    expect(
      redactHeaders({ Authorization: "Bearer x", "Set-Cookie": "a=1", cookie: "b=2", "Content-Type": "text/html" }),
    ).toEqual({
      Authorization: "[REDACTED]",
      "Set-Cookie": "[REDACTED]",
      cookie: "[REDACTED]",
      "Content-Type": "text/html",
    });
  });

  it("ingestCdpEvent:请求建条目、响应补状态与脱敏响应头", () => {
    ingestCdpEvent("Network.requestWillBeSent", {
      requestId: "1",
      request: { url: "https://x/api", method: "POST", headers: { Authorization: "Bearer s" } },
    });
    ingestCdpEvent("Network.responseReceived", {
      requestId: "1",
      response: { status: 200, headers: { "Set-Cookie": "sess=abc" } },
    });
    const net = readNetwork();
    expect(net).toHaveLength(1);
    expect(net[0]).toMatchObject({
      url: "https://x/api",
      method: "POST",
      status: 200,
      requestHeaders: { Authorization: "[REDACTED]" },
      responseHeaders: { "Set-Cookie": "[REDACTED]" },
    });
  });

  it("缺 url 的请求事件忽略;响应无匹配请求安全跳过", () => {
    ingestCdpEvent("Network.requestWillBeSent", { requestId: "2", request: {} });
    ingestCdpEvent("Network.responseReceived", { requestId: "999", response: { status: 500 } });
    expect(readNetwork()).toHaveLength(0);
  });
});
