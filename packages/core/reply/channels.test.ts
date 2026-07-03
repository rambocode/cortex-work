import { describe, expect, it } from "vitest";

import {
  CHANNEL_IDS,
  CHANNEL_DESCRIPTORS,
  ChannelVerifyError,
  GmailEnvError,
  channelDescriptor,
  makeGoogleRequest,
  makeGoogleTokenRequest,
  makeLarkRequest,
  makeSlackRequest,
  parseGmailEnv,
  parseGoogle,
  parseGoogleTokenResponse,
  parseLark,
  parseSlack,
} from "./channels";

// MARK: - 渠道目录(源 channelDescriptorCatalogCoversAllIDs)

describe("渠道目录", () => {
  it("覆盖全部 ChannelId(descriptor 强制查找依赖这一点)", () => {
    const catalogIds = new Set(CHANNEL_DESCRIPTORS.map((d) => d.id));
    expect(catalogIds).toEqual(new Set(CHANNEL_IDS));
  });

  it("每个 ID 都能查到目录项", () => {
    for (const id of CHANNEL_IDS) {
      expect(channelDescriptor(id).id).toBe(id);
    }
  });
});

// MARK: - Slack 校验(源 slackRequest* / slackParse*)

describe("Slack 校验", () => {
  it("请求打到 auth.test 且带 Bearer", () => {
    const request = makeSlackRequest("xoxp-abc");
    expect(request.url).toBe("https://slack.com/api/auth.test");
    expect(request.method).toBe("POST");
    expect(request.headers?.Authorization).toBe("Bearer xoxp-abc");
  });

  it("解析出身份(账号名 + 团队)", () => {
    const identity = parseSlack(
      '{"ok":true,"url":"https://acme.slack.com/","team":"Acme","user":"mike","team_id":"T1","user_id":"U1"}',
    );
    expect(identity).toEqual({ accountName: "mike", accountDetail: "Acme" });
  });

  it("ok:false 抛 apiError(HTTP 200 也算业务失败)", () => {
    try {
      parseSlack('{"ok":false,"error":"invalid_auth"}');
      throw new Error("should have thrown");
    } catch (error) {
      expect(error).toBeInstanceOf(ChannelVerifyError);
      expect((error as ChannelVerifyError).kind).toBe("apiError");
      expect((error as ChannelVerifyError).detail).toBe("invalid_auth");
    }
  });
});

// MARK: - Lark 校验(源 larkRequest* / larkParse*)

describe("Lark 校验", () => {
  it("请求打到 user_info 且带 Bearer", () => {
    const request = makeLarkRequest("u-token");
    expect(request.url).toBe(
      "https://open.larksuite.com/open-apis/authen/v1/user_info",
    );
    expect(request.headers?.Authorization).toBe("Bearer u-token");
  });

  it("解析出姓名 + 邮箱", () => {
    const identity = parseLark(
      '{"code":0,"msg":"success","data":{"name":"张三","email":"zhang@acme.com","open_id":"ou_1"}}',
    );
    expect(identity).toEqual({ accountName: "张三", accountDetail: "zhang@acme.com" });
  });

  it("code != 0 抛 apiError", () => {
    try {
      parseLark('{"code":99991668,"msg":"token invalid"}');
      throw new Error("should have thrown");
    } catch (error) {
      expect(error).toBeInstanceOf(ChannelVerifyError);
      expect((error as ChannelVerifyError).kind).toBe("apiError");
      expect((error as ChannelVerifyError).detail).toBe("token invalid");
    }
  });
});

// MARK: - Google 校验(源 googleRequest* / googleParse* / googleTokenExchange*)

describe("Google 校验", () => {
  it("tokeninfo 请求带上 access_token", () => {
    const request = makeGoogleRequest("ya29.abc");
    expect(request.url).toBe("https://oauth2.googleapis.com/tokeninfo?access_token=ya29.abc");
  });

  it("解析出邮箱", () => {
    const identity = parseGoogle(
      '{"azp":"1.apps.googleusercontent.com","email":"mike@gmail.com","scope":"https://www.googleapis.com/auth/gmail.readonly","expires_in":"3555"}',
    );
    expect(identity).toEqual({ accountName: "mike@gmail.com" });
  });

  it("缺 email 抛 invalidResponse", () => {
    try {
      parseGoogle('{"error":"invalid_token"}');
      throw new Error("should have thrown");
    } catch (error) {
      expect(error).toBeInstanceOf(ChannelVerifyError);
      expect((error as ChannelVerifyError).kind).toBe("invalidResponse");
    }
  });

  it("refresh 交换请求是 form POST,响应取 access_token", () => {
    const request = makeGoogleTokenRequest({
      clientID: "cid",
      clientSecret: "sec",
      refreshToken: "rt",
    });
    expect(request.url).toBe("https://oauth2.googleapis.com/token");
    expect(request.method).toBe("POST");
    expect(request.body).toContain("grant_type=refresh_token");
    expect(request.body).toContain("refresh_token=rt");

    const token = parseGoogleTokenResponse(
      '{"access_token":"ya29.new","expires_in":3599,"token_type":"Bearer"}',
    );
    expect(token).toBe("ya29.new");
  });
});

// MARK: - Gmail 环境凭据(源 gmailEnv*)

describe("parseGmailEnv", () => {
  it("容忍注释/空行,值含 = 时只按首个 = 分割", () => {
    const text = [
      "# Google OAuth 凭据",
      "GOOGLE_OAUTH_CLIENT_ID=abc.apps.googleusercontent.com",
      "",
      "GOOGLE_OAUTH_CLIENT_SECRET = GOCSPX-secret",
      "GMAIL_REFRESH_TOKEN=1//token=with=equals",
    ].join("\n");

    const credentials = parseGmailEnv(text);
    expect(credentials.clientID).toBe("abc.apps.googleusercontent.com");
    expect(credentials.clientSecret).toBe("GOCSPX-secret");
    expect(credentials.refreshToken).toBe("1//token=with=equals");
  });

  it("缺必需 key 抛 missingKey", () => {
    try {
      parseGmailEnv("GOOGLE_OAUTH_CLIENT_ID=abc");
      throw new Error("should have thrown");
    } catch (error) {
      expect(error).toBeInstanceOf(GmailEnvError);
      expect((error as GmailEnvError).missingKey).toBe("GOOGLE_OAUTH_CLIENT_SECRET");
    }
  });

  it("refresh token 可选:浏览器授权只需 client id/secret", () => {
    const credentials = parseGmailEnv(
      "GOOGLE_OAUTH_CLIENT_ID=abc\nGOOGLE_OAUTH_CLIENT_SECRET=sec",
    );
    expect(credentials.refreshToken).toBeUndefined();
  });
});
