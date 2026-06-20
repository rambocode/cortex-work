import { describe, it, expect } from "vitest";
import type { Message } from "../types";
import {
  extractAutoOpenDevPreviewUrls,
  extractDetectedDevPreviewUrls,
  extractDetectedLocalHtmlPaths,
  extractLatestTurnAutoOpenDevPreviewUrls,
  formatDevPreviewUrlLabel,
  formatLocalHtmlLabel,
} from "./devPreviewDetection";

function txt(text: string, who = "claude"): Message {
  return { kind: "text", who, time: "10:00", text };
}
function me(text: string): Message {
  return { kind: "text", who: "me", time: "10:00", text };
}

describe("extractDetectedDevPreviewUrls(card)", () => {
  it("正文含「打开 + localhost」→ 探测出归一化 URL", () => {
    expect(extractDetectedDevPreviewUrls([txt("打开 http://localhost:5173 看看")])).toEqual([
      "http://localhost:5173/",
    ]);
  });

  it("私网 URL + dev 语境 → card 命中", () => {
    expect(
      extractDetectedDevPreviewUrls([txt("dev server 运行在 http://192.168.1.10:3000")]),
    ).toEqual(["http://192.168.1.10:3000/"]);
  });

  it("agentLog 的 item.text(RichText rich 形态)含本地 URL 能被扫到", () => {
    const msg: Message = {
      kind: "agentLog",
      who: "claude",
      time: "10:00",
      title: "运行命令",
      items: [
        { ic: "check", text: { kind: "rich", parts: [{ t: "code", v: "npm run dev" }] } },
        { ic: "check", text: { kind: "rich", parts: [{ t: "text", v: "Local: http://127.0.0.1:5173/" }] } },
      ],
    };
    expect(extractDetectedDevPreviewUrls([msg])).toEqual(["http://127.0.0.1:5173/"]);
  });

  it("端点过滤:/health /metrics /v1 不计入", () => {
    expect(
      extractDetectedDevPreviewUrls([txt("打开 http://localhost:8080/health")]),
    ).toEqual([]);
    expect(
      extractDetectedDevPreviewUrls([txt("访问 http://localhost:9090/metrics")]),
    ).toEqual([]);
  });

  it("NON_PREVIEW 上下文(bearer token/sse)不展卡片", () => {
    expect(
      extractDetectedDevPreviewUrls([txt("用 bearer token 调用 http://localhost:5173/api")]),
    ).toEqual([]);
  });

  it("公网 URL 一律不计入", () => {
    expect(extractDetectedDevPreviewUrls([txt("打开 http://8.8.8.8:3000")])).toEqual([]);
  });

  it("无 dev 语境的裸 localhost 不展卡片(text 需要动作/状态措辞)", () => {
    expect(extractDetectedDevPreviewUrls([txt("随便提一句 http://localhost:5173")])).toEqual([]);
  });

  it("同 URL 去重,且最多 4 条", () => {
    const msgs = [
      txt("打开 http://localhost:3001"),
      txt("打开 http://localhost:3002"),
      txt("打开 http://localhost:3003"),
      txt("打开 http://localhost:3004"),
      txt("打开 http://localhost:3005"),
      txt("再打开 http://localhost:3001"),
    ];
    const urls = extractDetectedDevPreviewUrls(msgs);
    expect(urls.length).toBe(4);
    expect(new Set(urls).size).toBe(4);
  });
});

describe("extractAutoOpenDevPreviewUrls(收紧到环回)", () => {
  it("正文像 dev server + 环回 → 命中", () => {
    expect(
      extractAutoOpenDevPreviewUrls([txt("vite v5 ready in 200 ms\nLocal: http://127.0.0.1:5173/")]),
    ).toEqual(["http://127.0.0.1:5173/"]);
  });

  it("私网即便 card 命中也不进 auto_open(SSRF 收紧)", () => {
    const msgs = [txt("vite v5 ready\nNetwork: http://192.168.1.10:3000/")];
    expect(extractDetectedDevPreviewUrls(msgs)).toEqual(["http://192.168.1.10:3000/"]);
    expect(extractAutoOpenDevPreviewUrls(msgs)).toEqual([]);
  });

  it("169.254 metadata 段不进 auto_open", () => {
    expect(
      extractAutoOpenDevPreviewUrls([txt("vite v5 ready\nLocal: http://169.254.169.254/")]),
    ).toEqual([]);
  });

  it("纯 localhost 无 dev server 特征 → 不 auto_open", () => {
    expect(extractAutoOpenDevPreviewUrls([txt("打开 http://localhost:5173")])).toEqual([]);
  });
});

describe("extractLatestTurnAutoOpenDevPreviewUrls", () => {
  it("只看最近一条 user 之后的消息", () => {
    const msgs = [
      txt("vite v5 ready\nLocal: http://127.0.0.1:4000/"),
      me("再起一个"),
      txt("vite v5 ready\nLocal: http://127.0.0.1:5173/"),
    ];
    expect(extractLatestTurnAutoOpenDevPreviewUrls(msgs)).toEqual(["http://127.0.0.1:5173/"]);
  });
});

describe("formatDevPreviewUrlLabel", () => {
  it("取 host", () => {
    expect(formatDevPreviewUrlLabel("http://127.0.0.1:5173/")).toBe("127.0.0.1:5173");
  });
});

describe("extractDetectedLocalHtmlPaths", () => {
  it("探测 open 命令里的绝对 .html 路径", () => {
    expect(
      extractDetectedLocalHtmlPaths([
        txt("用浏览器打开即可:\nopen /Users/mike/Documents/cortex/2026-06-20/hangzhou-weather-today.html"),
      ]),
    ).toEqual(["/Users/mike/Documents/cortex/2026-06-20/hangzhou-weather-today.html"]);
  });

  it("支持 ~ 家目录路径与 .htm", () => {
    expect(extractDetectedLocalHtmlPaths([txt("见 ~/docs/report.htm")])).toEqual([
      "~/docs/report.htm",
    ]);
  });

  it("裸文件名(无路径)不匹配——无法授权解析", () => {
    expect(extractDetectedLocalHtmlPaths([txt("已生成 hangzhou-weather-today.html")])).toEqual([]);
  });

  it("非 .html 路径不匹配", () => {
    expect(extractDetectedLocalHtmlPaths([txt("写了 /Users/mike/foo.md 和 /Users/mike/a.js")])).toEqual(
      [],
    );
  });

  it("去重 + 从 agentLog 文本扫描", () => {
    const msg: Message = {
      kind: "agentLog",
      who: "claude",
      time: "10:00",
      title: "写文件",
      items: [{ ic: "check", text: "Wrote /tmp/site/index.html" }],
    };
    expect(extractDetectedLocalHtmlPaths([msg, txt("再看 /tmp/site/index.html")])).toEqual([
      "/tmp/site/index.html",
    ]);
  });
});

describe("formatLocalHtmlLabel", () => {
  it("取文件名", () => {
    expect(formatLocalHtmlLabel("/Users/mike/Documents/cortex/2026-06-20/hangzhou-weather-today.html")).toBe(
      "hangzhou-weather-today.html",
    );
  });
});
