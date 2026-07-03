// 渠道凭据校验的纯逻辑层:渠道目录、请求描述构造、响应解析、gmail.env 解析。
//
// 分层(KTD4):真正的 fetch 由 main 侧执行;此处只做「构造请求描述」与「解析响应体」的纯函数,
// 与源项目 `ChannelCredentialVerifier` 的静态方法契约一致,便于测试且不引入出网依赖。

/// 全部可配置渠道的标识,连接渠道(IM/邮件)与日历渠道共用一套 ID。
export type ChannelId =
  | "lark"
  | "slack"
  | "gmail"
  | "localCalendar"
  | "larkCalendar"
  | "googleCalendar";

/// 全部渠道 ID 列表,`CHANNEL_DESCRIPTORS` 与之逐一对应(有测试保证,防解包缺口)。
export const CHANNEL_IDS: readonly ChannelId[] = [
  "lark",
  "slack",
  "gmail",
  "localCalendar",
  "larkCalendar",
  "googleCalendar",
];

/// 渠道大类:决定它出现在设置页的哪个分区。
export type ChannelKind = "messaging" | "calendar";

/// 渠道支持的连接方式,UI 据此决定渲染哪些按钮/输入框。
export type ChannelAuthMethod =
  | "oauthConnect" // 浏览器 OAuth(本期缓迁,降级为粘贴凭据)
  | "pasteToken" // 直接粘贴 access token(如 Slack xoxp- user token)
  | "envCredentials" // 从本机环境凭据文件读取(如 ~/.config/reply/gmail.env)
  | "systemAuthorization"; // 系统 TCC 授权(本地 macOS 日历),无 token 概念

/// 渠道的静态描述:名称、说明文案、凭据存储域名、支持的连接方式。
/// `CHANNEL_DESCRIPTORS` 是渠道目录的单一事实来源,UI 与状态管理都以此驱动。
export interface ChannelDescriptor {
  id: ChannelId;
  kind: ChannelKind;
  displayName: string;
  detail: string;
  /// safeStorage 密文的分域标识(systemAuthorization 渠道不使用)。
  credentialDomain: string;
  methods: readonly ChannelAuthMethod[];
}

/// 渠道目录:顺序即设置页内的展示顺序。必须覆盖全部 ChannelId(有测试保证)。
export const CHANNEL_DESCRIPTORS: readonly ChannelDescriptor[] = [
  {
    id: "lark",
    kind: "messaging",
    displayName: "Lark / 飞书",
    detail: "连接后直连 Lark OpenAPI 读取真实历史；token 本机加密存储，零服务端。",
    credentialDomain: "lark",
    methods: ["oauthConnect", "pasteToken"],
  },
  {
    id: "slack",
    kind: "messaging",
    displayName: "Slack",
    detail: "连接后读取频道与私信上下文；支持粘贴 User OAuth Token（xoxp-）。",
    credentialDomain: "slack",
    methods: ["oauthConnect", "pasteToken"],
  },
  {
    id: "gmail",
    kind: "messaging",
    displayName: "Gmail",
    detail: "连接 Gmail（令牌只存本机加密存储），从你已发邮件蒸出邮件语气。",
    credentialDomain: "google",
    methods: ["oauthConnect", "pasteToken", "envCredentials"],
  },
  {
    id: "localCalendar",
    kind: "calendar",
    displayName: "本地 (macOS)",
    detail: "读取本机日历的空闲时段，约时间时建议可用时间。",
    credentialDomain: "",
    methods: ["systemAuthorization"],
  },
  {
    id: "larkCalendar",
    kind: "calendar",
    displayName: "Lark 日历",
    detail: "读取 Lark 日历忙闲；与 Lark 渠道共用凭据。",
    credentialDomain: "lark",
    methods: ["oauthConnect", "pasteToken"],
  },
  {
    id: "googleCalendar",
    kind: "calendar",
    displayName: "Google 日历",
    detail: "读取 Google 日历忙闲；与 Gmail 共用 Google 凭据。",
    credentialDomain: "google",
    methods: ["oauthConnect", "pasteToken"],
  },
];

/// 按 ID 查目录项;目录覆盖全部 ChannelId(有测试保证),命中即返回。
export function channelDescriptor(id: ChannelId): ChannelDescriptor {
  const found = CHANNEL_DESCRIPTORS.find((descriptor) => descriptor.id === id);
  if (!found) {
    // 理论上不可达(目录完整性由测试守卫),显式抛错便于早发现回归
    throw new Error(`未知渠道 ID: ${id}`);
  }
  return found;
}

/// 单个渠道的动态连接状态(仅非敏感元数据;token 密文另存,不在此)。
export interface ChannelConnectionState {
  id: ChannelId;
  isConnected: boolean;
  /// 凭据校验接口返回的账号身份(如 Slack 用户名、Gmail 邮箱)。
  accountName?: string;
  accountDetail?: string;
  /// 连接建立时间(epoch ms)。
  connectedAt?: number;
}

/// 凭据校验通过后从 API 提取的账号身份,用于设置页展示「以谁的身份连接」。
export interface VerifiedIdentity {
  accountName: string;
  accountDetail?: string;
}

/// 由 main 侧据此发起 fetch 的请求描述(纯数据,不含 fetch 本身)。
export interface ChannelRequest {
  url: string;
  method: "GET" | "POST";
  headers?: Record<string, string>;
  body?: string;
}

/// 渠道校验错误类型。
/// - httpStatus: 非 2xx(由 main 侧发现并抛,parse 层不产出);
/// - invalidResponse: 响应无法解析或缺关键字段;
/// - apiError: HTTP 200 但业务层报错(Slack ok:false、Lark code!=0),携带 API 错误码。
export type ChannelVerifyErrorKind = "httpStatus" | "invalidResponse" | "apiError";

export class ChannelVerifyError extends Error {
  readonly kind: ChannelVerifyErrorKind;
  /// apiError 携带的错误码 / httpStatus 携带的状态码文本。
  readonly detail?: string;

  constructor(kind: ChannelVerifyErrorKind, detail?: string) {
    super(detail ? `${kind}: ${detail}` : kind);
    this.name = "ChannelVerifyError";
    this.kind = kind;
    this.detail = detail;
  }
}

/// 安全 JSON 解析:失败一律折算成 invalidResponse(对应 Swift decode-from-Data 失败)。
function parseJson(raw: string): unknown {
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    throw new ChannelVerifyError("invalidResponse");
  }
}

// MARK: - Slack(auth.test)

/// POST https://slack.com/api/auth.test,Bearer 鉴权。
export function makeSlackRequest(token: string): ChannelRequest {
  return {
    url: "https://slack.com/api/auth.test",
    method: "POST",
    headers: { Authorization: `Bearer ${token}` },
  };
}

/// 解析 auth.test 响应。Slack 业务失败也返回 HTTP 200,必须读 ok 字段判断。
export function parseSlack(raw: string): VerifiedIdentity {
  const decoded = parseJson(raw) as {
    ok?: boolean;
    user?: string;
    team?: string;
    error?: string;
  };
  if (!decoded.ok) {
    throw new ChannelVerifyError("apiError", decoded.error ?? "unknown_error");
  }
  if (!decoded.user) {
    throw new ChannelVerifyError("invalidResponse");
  }
  return { accountName: decoded.user, accountDetail: decoded.team };
}

// MARK: - Lark(user_info)

/// GET https://open.larksuite.com/open-apis/authen/v1/user_info,Bearer 鉴权。
export function makeLarkRequest(token: string): ChannelRequest {
  return {
    url: "https://open.larksuite.com/open-apis/authen/v1/user_info",
    method: "GET",
    headers: { Authorization: `Bearer ${token}` },
  };
}

/// 解析 user_info 响应。Lark 业务失败也可能 HTTP 200,必须读 code 字段判断。
export function parseLark(raw: string): VerifiedIdentity {
  const decoded = parseJson(raw) as {
    code?: number;
    msg?: string;
    data?: { name?: string; email?: string; enterprise_email?: string };
  };
  if (decoded.code !== 0) {
    throw new ChannelVerifyError("apiError", decoded.msg ?? `code ${decoded.code}`);
  }
  const name = decoded.data?.name;
  if (!name) {
    throw new ChannelVerifyError("invalidResponse");
  }
  return {
    accountName: name,
    accountDetail: decoded.data?.email ?? decoded.data?.enterprise_email,
  };
}

// MARK: - Google(tokeninfo + refresh 交换)

/// GET https://oauth2.googleapis.com/tokeninfo?access_token=...
export function makeGoogleRequest(token: string): ChannelRequest {
  return {
    url: `https://oauth2.googleapis.com/tokeninfo?access_token=${encodeURIComponent(token)}`,
    method: "GET",
  };
}

/// 解析 tokeninfo 响应,email 缺失(token 无 email scope 或无效)视为无效响应。
export function parseGoogle(raw: string): VerifiedIdentity {
  const decoded = parseJson(raw) as { email?: string; scope?: string };
  if (!decoded.email) {
    throw new ChannelVerifyError("invalidResponse");
  }
  return { accountName: decoded.email };
}

/// POST https://oauth2.googleapis.com/token,grant_type=refresh_token 表单。
/// refresh token 本身无法直接校验,必须先走一次 token 交换换取 access token。
export function makeGoogleTokenRequest(params: {
  clientID: string;
  clientSecret: string;
  refreshToken: string;
}): ChannelRequest {
  const form = new URLSearchParams({
    client_id: params.clientID,
    client_secret: params.clientSecret,
    refresh_token: params.refreshToken,
    grant_type: "refresh_token",
  });
  return {
    url: "https://oauth2.googleapis.com/token",
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: form.toString(),
  };
}

/// 解析 token 交换响应,取 access_token。
export function parseGoogleTokenResponse(raw: string): string {
  const decoded = parseJson(raw) as { access_token?: string };
  if (!decoded.access_token) {
    throw new ChannelVerifyError("invalidResponse");
  }
  return decoded.access_token;
}

// MARK: - Gmail 环境凭据(~/.config/reply/gmail.env)

/// 从本机环境凭据文件读取的 Google OAuth 凭据。
export interface GmailEnvCredentials {
  clientID: string;
  clientSecret: string;
  /// 可选:浏览器授权只需要 client id/secret,「环境凭据同步」才要求它。
  refreshToken?: string;
}

/// gmail.env 缺少必需 key 时抛出,携带缺失的 key 名供上层给出明确提示。
export class GmailEnvError extends Error {
  readonly missingKey: string;

  constructor(missingKey: string) {
    super(`missing key: ${missingKey}`);
    this.name = "GmailEnvError";
    this.missingKey = missingKey;
  }
}

/// 解析 env 文本:忽略空行与 # 注释;值里允许再出现 =(只按第一个 = 分割)。
export function parseGmailEnv(text: string): GmailEnvCredentials {
  const values: Record<string, string> = {};
  for (const rawLine of text.split("\n")) {
    const line = rawLine.trim();
    if (line.length === 0 || line.startsWith("#")) continue;
    const separator = line.indexOf("=");
    if (separator < 0) continue;
    const key = line.slice(0, separator).trim();
    // 值里可能含 =(如 refresh token 的 `1//token=with=equals`),只按首个 = 分割
    const value = line.slice(separator + 1).trim();
    values[key] = value;
  }
  const requireKey = (key: string): string => {
    const value = values[key];
    if (!value || value.length === 0) {
      throw new GmailEnvError(key);
    }
    return value;
  };
  const refreshToken = values.GMAIL_REFRESH_TOKEN;
  return {
    clientID: requireKey("GOOGLE_OAUTH_CLIENT_ID"),
    clientSecret: requireKey("GOOGLE_OAUTH_CLIENT_SECRET"),
    refreshToken: refreshToken && refreshToken.length > 0 ? refreshToken : undefined,
  };
}
