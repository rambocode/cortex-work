import { describe, expect, it } from "vitest";
import { mergeImCredentials, normalizeImPlatformSpecs } from "./im-contract";

describe("normalizeImPlatformSpecs", () => {
  it("把 Go snake_case 契约转换成设置页使用的 camelCase", () => {
    expect(
      normalizeImPlatformSpecs([
        {
          platform: "wecom",
          modes: ["websocket", "webhook"],
          default_mode: "websocket",
          credential_fields: ["bot_id", "bot_secret"],
        },
      ]),
    ).toEqual([
      {
        platform: "wecom",
        modes: ["websocket", "webhook"],
        defaultMode: "websocket",
        credentialFields: ["bot_id", "bot_secret"],
      },
    ]);
  });
});

describe("mergeImCredentials", () => {
  it("只覆盖非空字段，留空字段保留原密钥", () => {
    expect(mergeImCredentials(
      { bot_id: "old-id", bot_secret: "old-secret" },
      { bot_id: "new-id", bot_secret: "   " },
    )).toEqual({ bot_id: "new-id", bot_secret: "old-secret" });
  });
});
