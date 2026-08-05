import { describe, expect, it } from "vitest";
import { secMsGecToken } from "./drm";

describe("secMsGecToken", () => {
  it("以五分钟窗口生成 Microsoft Edge TTS 握手签名", () => {
    expect(secMsGecToken(0)).toBe("7ECB79D14E3AA576D2D79E6D487A1388156D91E614B1BE11C64226A29BC8DD8C");
  });

  it("同一五分钟窗口内签名稳定，跨窗口才变化", () => {
    expect(secMsGecToken(299_999)).toBe(secMsGecToken(0));
    expect(secMsGecToken(300_000)).not.toBe(secMsGecToken(0));
  });
});
