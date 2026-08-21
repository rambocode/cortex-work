// LoginGate（W1）：团队工作区未登录时呈现的内嵌登录卡（不拦个人工作区）。三步线性流程：
//   ① 服务器地址 + 邮箱 → 发送验证码（60s 倒计时，429 提示稍后再试）
//   ② 6 位验证码 → verify-code 换 JWT/user（verify 自动建号，无需预注册）
//   ③ 选择/接受邀请/新建工作区 → 确定 → onAuthenticated
// 全部 fetch 走全局 fetch（views 允许），错误可视化；步骤状态机与 slug 派生在 auth-helpers.ts（纯函数、就近单测）。
// 已登录时的账号/退出入口复用 OrgSwitcher 下拉菜单里的退出菜单项（见 OrgSwitcher.tsx），
// 不再由本文件单独渲染顶部账号条。

import { useEffect, useState, type CSSProperties, type ReactNode } from "react";
import { useTranslation } from "@cortex-work/core/i18n";
import {
  AUTH_STEPS,
  type AuthStep,
  nextAuthStep,
  prevAuthStep,
  deriveSlug,
  isValidSlug,
  isValidEmail,
  isValidCode,
  normalizeBaseUrl,
} from "./auth-helpers";

// 登录成功回传给壳的完整配置（apiUrl/token/workspace + 用户身份）。
export interface AuthedResult {
  apiUrl: string;
  token: string;
  workspaceId: string;
  workspaceSlug?: string;
  // 服务端用户主键(UUID),与 ApiAvatar.owner.id 同一格式——个人工作区"我的角色会话"等
  // owner 视角功能靠它匹配"当前用户是不是某分身的拥有者",不可省略/不可用 email 代替。
  userId?: string;
  userName?: string;
  userEmail?: string;
}

export interface LoginGateProps {
  defaultBaseUrl: string;
  onAuthenticated: (cfg: AuthedResult) => void;
}

interface WorkspaceRow {
  id: string;
  name: string;
  slug?: string;
}
interface InvitationRow {
  id: string;
  workspace_id: string;
  workspace_name: string;
  inviter_name?: string;
  role?: string;
  expires_at?: string;
}

const RESEND_SECONDS = 60;

export function LoginGate({ defaultBaseUrl, onAuthenticated }: LoginGateProps) {
  const { t } = useTranslation("settings");

  const [step, setStep] = useState<AuthStep>("server");
  const [baseUrl, setBaseUrl] = useState(defaultBaseUrl || "http://127.0.0.1:8080");
  const [email, setEmail] = useState("");
  const [code, setCode] = useState("");
  const [token, setToken] = useState("");
  const [userId, setUserId] = useState<string | undefined>();
  const [userName, setUserName] = useState<string | undefined>();
  const [userEmail, setUserEmail] = useState<string | undefined>();

  const [workspaces, setWorkspaces] = useState<WorkspaceRow[]>([]);
  const [invitations, setInvitations] = useState<InvitationRow[]>([]);
  const [selectedWsId, setSelectedWsId] = useState<string>("");

  const [newName, setNewName] = useState("");
  const [newSlug, setNewSlug] = useState("");
  const [slugEdited, setSlugEdited] = useState(false);

  const [countdown, setCountdown] = useState(0);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string>("");

  // 倒计时 tick：每秒自减到 0（重发按钮据此禁用）。清理定时器避免卸载后野悬。
  useEffect(() => {
    if (countdown <= 0) return;
    const timer = setTimeout(() => setCountdown((s) => s - 1), 1000);
    return () => clearTimeout(timer);
  }, [countdown]);

  // 统一副作用包装：进入即清错 + 置 loading，结束复位。fn 抛错时落 errKey 文案。
  const run = async (fn: () => Promise<void>, errKey: string) => {
    setError("");
    setLoading(true);
    try {
      await fn();
    } catch {
      setError(t(errKey));
    } finally {
      setLoading(false);
    }
  };

  const api = () => normalizeBaseUrl(baseUrl);
  const authHeaders = (): Record<string, string> => ({
    "Content-Type": "application/json",
    Authorization: `Bearer ${token}`,
  });

  // ① 发送验证码。429 → 限流提示；非 2xx → 通用发送失败（多为服务器地址错）。
  const handleSendCode = () =>
    run(async () => {
      if (!isValidEmail(email)) {
        setError(t("auth.errInvalidEmail"));
        return;
      }
      const res = await fetch(`${api()}/auth/send-code`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: email.trim() }),
      });
      if (res.status === 429) {
        setError(t("auth.errRateLimit"));
        return;
      }
      if (!res.ok) {
        setError(t("auth.errSendFailed"));
        return;
      }
      setCountdown(RESEND_SECONDS);
      setStep(nextAuthStep("server"));
    }, "auth.errSendFailed");

  // 重发（倒计时内禁用）。复用发送逻辑但不推进步骤。
  const handleResend = () =>
    run(async () => {
      const res = await fetch(`${api()}/auth/send-code`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: email.trim() }),
      });
      if (res.status === 429) {
        setError(t("auth.errRateLimit"));
        return;
      }
      if (!res.ok) {
        setError(t("auth.errSendFailed"));
        return;
      }
      setCountdown(RESEND_SECONDS);
    }, "auth.errSendFailed");

  // ② 校验验证码 → 换 token/user，随后拉工作区与邀请列表，推进到选择步。
  const handleVerify = () =>
    run(async () => {
      if (!isValidCode(code)) {
        setError(t("auth.errInvalidCode"));
        return;
      }
      const res = await fetch(`${api()}/auth/verify-code`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: email.trim(), code: code.trim() }),
      });
      if (!res.ok) {
        setError(t("auth.errInvalidCode"));
        return;
      }
      const data = (await res.json().catch(() => null)) as
        | { token?: string; user?: { id?: string; name?: string; email?: string } }
        | null;
      if (!data?.token) {
        setError(t("auth.errVerifyFailed"));
        return;
      }
      setToken(data.token);
      setUserId(data.user?.id);
      setUserName(data.user?.name);
      setUserEmail(data.user?.email ?? email.trim());
      await loadWorkspacesAndInvites(data.token);
      setStep(nextAuthStep("code"));
    }, "auth.errVerifyFailed");

  // 拉「我的工作区」+「待接受邀请」。token 显式传入（verify 后 state 尚未提交）。best-effort：
  // 任一失败落错误提示但不阻断另一个（都空时用户可走建团路径）。
  const loadWorkspacesAndInvites = async (jwt: string) => {
    const h = { "Content-Type": "application/json", Authorization: `Bearer ${jwt}` };
    try {
      const [wsRes, invRes] = await Promise.all([
        fetch(`${api()}/api/workspaces`, { headers: h }),
        fetch(`${api()}/api/invitations`, { headers: h }),
      ]);
      const ws = wsRes.ok ? ((await wsRes.json().catch(() => [])) as WorkspaceRow[]) : [];
      const inv = invRes.ok ? ((await invRes.json().catch(() => [])) as InvitationRow[]) : [];
      setWorkspaces(Array.isArray(ws) ? ws : []);
      setInvitations(Array.isArray(inv) ? inv : []);
      if (Array.isArray(ws) && ws[0]) setSelectedWsId(ws[0].id);
    } catch {
      setError(t("auth.errLoadFailed"));
    }
  };

  // 接受邀请：410 → 过期提示；成功 → 并入工作区列表并选中。
  const handleAccept = (inv: InvitationRow) =>
    run(async () => {
      const res = await fetch(`${api()}/api/invitations/${inv.id}/accept`, {
        method: "POST",
        headers: authHeaders(),
      });
      if (res.status === 410) {
        setError(t("auth.errInviteExpired"));
        return;
      }
      if (!res.ok) {
        setError(t("auth.errAcceptFailed"));
        return;
      }
      setInvitations((list) => list.filter((i) => i.id !== inv.id));
      setWorkspaces((list) =>
        list.some((w) => w.id === inv.workspace_id)
          ? list
          : [...list, { id: inv.workspace_id, name: inv.workspace_name }],
      );
      setSelectedWsId(inv.workspace_id);
    }, "auth.errAcceptFailed");

  // 新建团队：409 → slug 冲突；201 → 并入列表并选中。slug 未手改时随团队名自动派生。
  const handleCreate = () =>
    run(async () => {
      const name = newName.trim();
      const slug = slugEdited ? newSlug.trim() : deriveSlug(newName);
      if (!name) return;
      if (!isValidSlug(slug)) {
        setError(t("auth.errInvalidSlug"));
        return;
      }
      const res = await fetch(`${api()}/api/workspaces`, {
        method: "POST",
        headers: authHeaders(),
        body: JSON.stringify({ name, slug }),
      });
      if (res.status === 409) {
        setError(t("auth.errSlugConflict"));
        return;
      }
      if (!res.ok) {
        setError(t("auth.errCreateFailed"));
        return;
      }
      const created = (await res.json().catch(() => null)) as WorkspaceRow | null;
      if (!created?.id) {
        setError(t("auth.errCreateFailed"));
        return;
      }
      setWorkspaces((list) => [...list, created]);
      setSelectedWsId(created.id);
      setNewName("");
      setNewSlug("");
      setSlugEdited(false);
    }, "auth.errCreateFailed");

  // ③ 确定：把选中工作区连同身份回传给壳。
  const handleConfirm = () => {
    const ws = workspaces.find((w) => w.id === selectedWsId);
    if (!ws) return;
    onAuthenticated({
      apiUrl: api(),
      token,
      workspaceId: ws.id,
      workspaceSlug: ws.slug,
      userId,
      userName,
      userEmail,
    });
  };

  // 团队名输入：未手改 slug 时同步派生。
  const onNameChange = (v: string) => {
    setNewName(v);
    if (!slugEdited) setNewSlug(deriveSlug(v));
  };

  const stepIndex = AUTH_STEPS.indexOf(step);

  return (
    <div style={{ flex: 1, display: "flex", alignItems: "center", justifyContent: "center", padding: 24, overflowY: "auto" }}>
      {/* auth-login-card:覆盖 .pw-input 的行式 flex-basis(纵向布局下会变成 200px 高),
          见 cortex-desktop.css §团队工作区登录卡。 */}
      <div className="pw-scard auth-login-card" style={{ width: 420, maxWidth: "100%", padding: 24, marginTop: 0 }}>
        <div style={{ fontSize: 17, fontWeight: 700, color: "var(--text-1)" }}>{t("auth.title")}</div>
        <div style={{ fontSize: 12.5, color: "var(--text-3)", lineHeight: 1.6, marginTop: 6, marginBottom: 18 }}>
          {t("auth.subtitle")}
        </div>

        {/* 步骤指示（server → code → workspace） */}
        <div style={{ display: "flex", gap: 6, marginBottom: 18 }}>
          {AUTH_STEPS.map((s, i) => (
            <div
              key={s}
              style={{
                flex: 1,
                height: 3,
                borderRadius: 2,
                background: i <= stepIndex ? "var(--accent)" : "var(--border)",
              }}
            />
          ))}
        </div>

        {step === "server" ? (
          <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
            <Field label={t("auth.serverLabel")}>
              <input className="pw-input" value={baseUrl} onChange={(e) => setBaseUrl(e.target.value)} placeholder="http://127.0.0.1:8080" />
            </Field>
            <Field label={t("auth.emailLabel")}>
              <input
                className="pw-input"
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder={t("auth.emailPlaceholder")}
                onKeyDown={(e) => e.key === "Enter" && !loading && handleSendCode()}
              />
            </Field>
            <button className="pw-tl-gen pw-btn-primary" onClick={handleSendCode} disabled={loading || !email.trim()} style={{ marginTop: 4 }}>
              {loading ? t("auth.sending") : t("auth.sendCode")}
            </button>
          </div>
        ) : null}

        {step === "code" ? (
          <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
            <div style={{ fontSize: 12.5, color: "var(--text-3)" }}>{t("auth.codeSentTo", { email: email.trim() })}</div>
            <Field label={t("auth.codeLabel")}>
              <input
                className="pw-input"
                value={code}
                onChange={(e) => setCode(e.target.value.replace(/\D/g, "").slice(0, 6))}
                placeholder={t("auth.codePlaceholder")}
                inputMode="numeric"
                autoFocus
                onKeyDown={(e) => e.key === "Enter" && !loading && handleVerify()}
              />
            </Field>
            <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
              <button className="pw-tl-gen pw-btn-primary" onClick={handleVerify} disabled={loading || !isValidCode(code)} style={{ flex: 1 }}>
                {loading ? t("auth.verifying") : t("auth.verify")}
              </button>
              <button className="pw-tl-gen" onClick={handleResend} disabled={loading || countdown > 0}>
                {countdown > 0 ? t("auth.resendIn", { sec: countdown }) : t("auth.resend")}
              </button>
            </div>
            <button className="pw-tl-gen" onClick={() => setStep(prevAuthStep("code"))} style={{ alignSelf: "flex-start", background: "transparent" }}>
              {t("auth.back")}
            </button>
          </div>
        ) : null}

        {step === "workspace" ? (
          <div style={{ display: "flex", flexDirection: "column", gap: 18 }}>
            {/* 我的团队 */}
            <section style={{ display: "flex", flexDirection: "column", gap: 8 }}>
              <div style={{ fontWeight: 600, fontSize: 13, color: "var(--text-2)" }}>{t("auth.myWorkspaces")}</div>
              {workspaces.length === 0 ? (
                <div style={{ fontSize: 12.5, color: "var(--text-4)" }}>{t("auth.noWorkspaces")}</div>
              ) : (
                workspaces.map((w) => (
                  <label key={w.id} style={rowStyle(selectedWsId === w.id)}>
                    <input type="radio" name="ws" checked={selectedWsId === w.id} onChange={() => setSelectedWsId(w.id)} />
                    <span style={{ fontWeight: 600, color: "var(--text-1)" }}>{w.name}</span>
                    {w.slug ? <span style={{ fontSize: 12, color: "var(--text-4)" }}>{w.slug}</span> : null}
                  </label>
                ))
              )}
            </section>

            {/* 待接受邀请 */}
            {invitations.length > 0 ? (
              <section style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                <div style={{ fontWeight: 600, fontSize: 13, color: "var(--text-2)" }}>{t("auth.invitations")}</div>
                {invitations.map((inv) => (
                  <div key={inv.id} style={{ ...rowStyle(false), justifyContent: "space-between" }}>
                    <div style={{ display: "flex", flexDirection: "column" }}>
                      <span style={{ fontWeight: 600, color: "var(--text-1)" }}>{inv.workspace_name}</span>
                      <span style={{ fontSize: 12, color: "var(--text-4)" }}>{t("auth.invitedBy", { inviter: inv.inviter_name ?? "" })}</span>
                    </div>
                    <button className="pw-tl-gen" onClick={() => handleAccept(inv)} disabled={loading}>
                      {t("auth.accept")}
                    </button>
                  </div>
                ))}
              </section>
            ) : null}

            {/* 新建团队 */}
            <section style={{ display: "flex", flexDirection: "column", gap: 8 }}>
              <div style={{ fontWeight: 600, fontSize: 13, color: "var(--text-2)" }}>{t("auth.createTitle")}</div>
              <input className="pw-input" value={newName} onChange={(e) => onNameChange(e.target.value)} placeholder={t("auth.teamNamePlaceholder")} />
              <input
                className="pw-input"
                value={newSlug}
                onChange={(e) => {
                  setSlugEdited(true);
                  setNewSlug(e.target.value);
                }}
                placeholder={t("auth.slugPlaceholder")}
              />
              <div style={{ fontSize: 11.5, color: "var(--text-4)" }}>{t("auth.slugHint")}</div>
              <button className="pw-tl-gen" onClick={handleCreate} disabled={loading || !newName.trim()} style={{ alignSelf: "flex-start" }}>
                {loading ? t("auth.creating") : t("auth.create")}
              </button>
            </section>

            <button className="pw-tl-gen pw-btn-primary" onClick={handleConfirm} disabled={!selectedWsId}>
              {t("auth.confirm")}
            </button>
          </div>
        ) : null}

        {error ? (
          <div style={{ marginTop: 14, fontSize: 12.5, color: "var(--danger, #e5484d)", lineHeight: 1.5 }} role="alert">
            {error}
          </div>
        ) : null}
      </div>
    </div>
  );
}

// 带标签的字段行（label + 控件竖排）。
function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <label style={{ display: "flex", flexDirection: "column", gap: 6 }}>
      <span style={{ fontSize: 12.5, fontWeight: 600, color: "var(--text-2)" }}>{label}</span>
      {children}
    </label>
  );
}

// 列表行样式（选中态高亮）。
function rowStyle(active: boolean): CSSProperties {
  return {
    display: "flex",
    alignItems: "center",
    gap: 10,
    padding: "10px 12px",
    borderRadius: 10,
    border: `1px solid ${active ? "var(--accent)" : "var(--border)"}`,
    background: active ? "var(--accent-soft, var(--bg-soft))" : "var(--bg-app)",
    cursor: "pointer",
  };
}
