// shared.test.ts — 媒体生成协议层公共工具单测。
// 覆盖：mapImageSize 档位/比例/auto 回退、minimaxImageDimensionFields、
// URL 规整、detectImageMime 魔数、bufferFromHex、delay、describeNetworkError。

import { describe, expect, it } from "vitest";
import {
  MediaGenHttpError,
  apiUrl,
  bufferFromHex,
  checkMinimaxBaseResp,
  dataUri,
  delay,
  describeNetworkError,
  detectImageMime,
  mapImageSize,
  minimaxImageDimensionFields,
  minimaxRootUrl,
  parseRatio,
  protocolSupportsImageEdit,
  sizeForLongEdge,
  trimTrailingSlashes,
  volcengineArkVideoTasksUrl,
} from "./shared";

describe("MediaGenHttpError", () => {
  it("携带 status 与 body", () => {
    const err = new MediaGenHttpError(404, "not found");
    expect(err.status).toBe(404);
    expect(err.body).toBe("not found");
    expect(err.message).toContain("404");
  });
});

describe("describeNetworkError", () => {
  it("摊平 cause 链并附 code", () => {
    const inner = Object.assign(new Error("connect ECONNREFUSED"), { code: "ECONNREFUSED" });
    const outer = new Error("fetch failed", { cause: inner });
    const text = describeNetworkError(outer);
    expect(text).toContain("fetch failed");
    expect(text).toContain("ECONNREFUSED");
  });

  it("非 Error 输入转字符串；空输入回落固定文案", () => {
    expect(describeNetworkError("boom")).toBe("boom");
    expect(describeNetworkError(null)).toBe("unknown network error");
  });
});

describe("URL 规整", () => {
  it("trimTrailingSlashes 去尾部斜杠", () => {
    expect(trimTrailingSlashes("https://a.com///")).toBe("https://a.com");
    expect(trimTrailingSlashes("https://a.com")).toBe("https://a.com");
  });

  it("apiUrl 容忍 baseUrl 带 /v1 或完整路径", () => {
    expect(apiUrl("https://a.com", "/v1/images/generations")).toBe("https://a.com/v1/images/generations");
    expect(apiUrl("https://a.com/v1", "/v1/images/generations")).toBe("https://a.com/v1/images/generations");
    expect(apiUrl("https://a.com/v1/images/generations", "/v1/images/generations")).toBe(
      "https://a.com/v1/images/generations",
    );
  });

  it("minimaxRootUrl 剥掉已知路径后缀", () => {
    expect(minimaxRootUrl("https://api.minimax.io/v1/video_generation")).toBe("https://api.minimax.io");
    expect(minimaxRootUrl("https://api.minimax.io/v1")).toBe("https://api.minimax.io");
    expect(minimaxRootUrl("https://api.minimax.io")).toBe("https://api.minimax.io");
  });

  it("volcengineArkVideoTasksUrl 拼接任务端点且不重复", () => {
    expect(volcengineArkVideoTasksUrl("https://ark.cn-beijing.volces.com/api/v3")).toBe(
      "https://ark.cn-beijing.volces.com/api/v3/contents/generations/tasks",
    );
    expect(
      volcengineArkVideoTasksUrl("https://ark.cn-beijing.volces.com/api/v3/contents/generations/tasks"),
    ).toBe("https://ark.cn-beijing.volces.com/api/v3/contents/generations/tasks");
  });
});

describe("编解码", () => {
  it("dataUri 输出 base64 数据 URI", () => {
    expect(dataUri("image/png", Buffer.from("abc"))).toBe("data:image/png;base64,YWJj");
  });

  it("bufferFromHex 解析合法 hex，拒绝非法输入", () => {
    expect(bufferFromHex("48656c6c6f").toString()).toBe("Hello");
    expect(bufferFromHex("48 65 6c\n6c 6f").toString()).toBe("Hello"); // 容忍空白
    expect(() => bufferFromHex("xyz")).toThrow(/hex/);
    expect(() => bufferFromHex("abc")).toThrow(/hex/); // 奇数长度
    expect(() => bufferFromHex("")).toThrow(/hex/);
  });
});

describe("delay", () => {
  it("正常等待后 resolve", async () => {
    const ctrl = new AbortController();
    await expect(delay(5, ctrl.signal)).resolves.toBeUndefined();
  });

  it("已中止的 signal 立即 reject（预中止检测）", async () => {
    const ctrl = new AbortController();
    ctrl.abort();
    await expect(delay(10_000, ctrl.signal)).rejects.toThrow(/已中止/);
  });

  it("等待中 abort → 提前 reject", async () => {
    const ctrl = new AbortController();
    const p = delay(10_000, ctrl.signal);
    ctrl.abort();
    await expect(p).rejects.toThrow(/取消/);
  });
});

describe("detectImageMime — 魔数嗅探", () => {
  const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);
  const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0]);
  const webp = Buffer.concat([
    Buffer.from("RIFF"),
    Buffer.from([0x10, 0x00, 0x00, 0x00]),
    Buffer.from("WEBP"),
  ]);

  it("识别 png/jpeg/webp", () => {
    expect(detectImageMime(png)).toBe("image/png");
    expect(detectImageMime(jpeg)).toBe("image/jpeg");
    expect(detectImageMime(webp)).toBe("image/webp");
  });

  it("其它格式与短 buffer 返回 undefined", () => {
    expect(detectImageMime(Buffer.from("GIF89a"))).toBeUndefined();
    expect(detectImageMime(Buffer.from([0x89]))).toBeUndefined();
    expect(detectImageMime(Buffer.alloc(0))).toBeUndefined();
  });
});

describe("mapImageSize", () => {
  it("显式档位优先：2K + 16:9 → 长边 2048 短边按比例对齐 64", () => {
    expect(mapImageSize("16:9", "2K", undefined, "1K")).toBe("2048x1152");
  });

  it("未知档位回落 1K", () => {
    expect(mapImageSize(undefined, "9K", undefined, "1K")).toBe("1024x1024");
  });

  it("无档位时用 defaultSize；带比例时按 defaultSize 长边换算", () => {
    expect(mapImageSize(undefined, undefined, "800x600", "1K")).toBe("800x600");
    expect(mapImageSize("1:1", undefined, "800x600", "1K")).toBe("800x800");
  });

  it("无比例且 defaultResolution=auto → 'auto' 透传", () => {
    expect(mapImageSize(undefined, undefined, undefined, "auto")).toBe("auto");
  });

  it("有比例的 auto 回落 1K 档（比例需要具体尺寸）", () => {
    expect(mapImageSize("16:9", undefined, undefined, "auto")).toBe("1024x576");
  });

  it("竖版比例：9:16 长边在高上", () => {
    expect(mapImageSize("9:16", "1K", undefined, "1K")).toBe("576x1024");
  });

  it("短边下限 256", () => {
    // 20:9 grok 比例 1K 档：1024 * 9/20 = 460.8 → 对齐 64 = 448。
    expect(mapImageSize("20:9", "1K", undefined, "1K")).toBe("1024x448");
  });
});

describe("sizeForLongEdge / parseRatio", () => {
  it("未知比例回落方形", () => {
    expect(sizeForLongEdge("7:5", 1024)).toBe("1024x1024");
    expect(parseRatio("7:5")).toBeNull();
    expect(parseRatio(undefined)).toBeNull();
  });

  it("已知比例正确解析（含 grok 扩展集）", () => {
    expect(parseRatio("16:9")).toEqual({ w: 16, h: 9 });
    expect(parseRatio("19.5:9")).toEqual({ w: 19.5, h: 9 });
  });
});

describe("protocolSupportsImageEdit — allowlist", () => {
  it("仅 openai-images 与 volcengine-ark-image 支持真编辑", () => {
    expect(protocolSupportsImageEdit("openai-images")).toBe(true);
    expect(protocolSupportsImageEdit("volcengine-ark-image")).toBe(true);
    expect(protocolSupportsImageEdit("minimax-image")).toBe(false);
    expect(protocolSupportsImageEdit("grok-imagine-image")).toBe(false);
    expect(protocolSupportsImageEdit(undefined)).toBe(false);
  });
});

describe("minimaxImageDimensionFields", () => {
  it("image-01 → 显式 width/height", () => {
    expect(minimaxImageDimensionFields("image-01", "1024x680")).toEqual({ width: 1024, height: 680 });
  });

  it("其它模型 → 最近的 aspect_ratio（1024x680 → 3:2）", () => {
    expect(minimaxImageDimensionFields("image-01-live", "1024x680")).toEqual({ aspect_ratio: "3:2" });
  });

  it("方形与竖版映射", () => {
    expect(minimaxImageDimensionFields("image-01-live", "1024x1024")).toEqual({ aspect_ratio: "1:1" });
    expect(minimaxImageDimensionFields("image-01-live", "576x1024")).toEqual({ aspect_ratio: "9:16" });
  });

  it("无尺寸或非法尺寸 → 空对象", () => {
    expect(minimaxImageDimensionFields("image-01", undefined)).toEqual({});
    expect(minimaxImageDimensionFields("image-01", "auto")).toEqual({});
    expect(minimaxImageDimensionFields("image-01", "0x100")).toEqual({});
  });
});

describe("checkMinimaxBaseResp", () => {
  it("status_code 0 或缺失不抛错", () => {
    expect(() => checkMinimaxBaseResp({ status_code: 0 }, "测试")).not.toThrow();
    expect(() => checkMinimaxBaseResp(undefined, "测试")).not.toThrow();
    expect(() => checkMinimaxBaseResp({}, "测试")).not.toThrow();
  });

  it("非 0 status_code 抛带诊断信息的错误", () => {
    expect(() => checkMinimaxBaseResp({ status_code: 2013, status_msg: "bad size" }, "图片生成"))
      .toThrow(/2013.*bad size/);
  });
});
