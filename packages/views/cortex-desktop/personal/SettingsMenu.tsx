// 个人工作区左栏底部「设置」入口 + 弹出层设置对话框。
// 对话框:左侧 Tab 菜单(宠物 / 外观),右侧详细内容;ESC / 遮罩 / ✕ 关闭。
//   宠物  → 4 个造型卡片(实时预览,点击切换)
//   外观  → 原右下角 Tweaks 迁移:布局密度 / 品牌色调 / 侧栏样式

import { useEffect, useState } from "react";
import { Icon } from "@cortex-work/ui/icons";
import { SegmentedRadio } from "@cortex-work/ui/controls/SegmentedRadio";
import { Toggle } from "@cortex-work/ui/controls/Toggle";
import { PaletteChips, type PaletteOption } from "@cortex-work/ui/controls/PaletteChips";
import { AGENT_MODELS, DEFAULT_MODEL, useCortexUIStore, usePersonalStore, usePetStore, type PetKind } from "@cortex-work/core";
import type {
  AgentKind,
  DingtalkPushConfig,
  EmailPushConfig,
  SummaryModelConfig,
  WecomPushConfig,
} from "@cortex-work/core";
import type { Density, Palette, SidebarMode } from "@cortex-work/core/types";
import { PET_DESIGNS, PET_KIND_KEY } from "../pet/designs";

const PALETTES: PaletteOption[] = [
  { id: "clay", name: "Clay", colors: ["#c96442", "#f3e7df", "#1a1916"] },
  { id: "twilight", name: "Twilight", colors: ["#7c3aed", "#ede5fd", "#1a1916"] },
  { id: "forest", name: "Forest", colors: ["#0d9488", "#d4ebe8", "#1a1916"] },
  { id: "ink", name: "Ink", colors: ["#1a1916", "#e6e4dd", "#5e5c56"] },
];

const PET_KINDS = Object.keys(PET_DESIGNS) as PetKind[];

type SettingsTab = "pet" | "appearance" | "timeline" | "push";

const TABS: { id: SettingsTab; label: string; icon: React.ReactNode }[] = [
  { id: "pet", label: "宠物", icon: <Icon.Sparkle size={14} /> },
  { id: "appearance", label: "外观", icon: <Icon.Image size={14} /> },
  { id: "timeline", label: "时间线", icon: <Icon.Clock size={14} /> },
  { id: "push", label: "推送", icon: <Icon.Send size={14} /> },
];

function PetSection() {
  const petKind = usePetStore((s) => s.kind);
  const setPetKind = usePetStore((s) => s.setKind);
  const pick = (k: PetKind) => {
    setPetKind(k);
    try {
      localStorage.setItem(PET_KIND_KEY, k);
    } catch {
      /* 忽略 */
    }
  };
  return (
    <>
      <div className="pw-dlg-title">桌面宠物</div>
      <div className="pw-dlg-desc">选择陪伴你工作的小伙伴,它会随输入、思考、执行工具等状态切换动画,可在界面上随意拖动。</div>
      <div className="pw-pet-grid">
        {PET_KINDS.map((k) => {
          const d = PET_DESIGNS[k];
          const Parts = d.Parts;
          return (
            <button key={k} className={`pw-pet-card ${k === petKind ? "is-active" : ""}`} onClick={() => pick(k)}>
              <span className="pet-preview">
                <svg viewBox="0 0 140 120" width="84" height="72" aria-hidden="true">
                  <Parts />
                </svg>
              </span>
              <span className="pw-pet-name">{d.name}</span>
              <span className="pw-pet-desc">{d.desc}</span>
            </button>
          );
        })}
      </div>
    </>
  );
}

function AppearanceSection() {
  const tweaks = useCortexUIStore((s) => s.tweaks);
  const setTweak = useCortexUIStore((s) => s.setTweak);
  return (
    <>
      <div className="pw-dlg-title">外观</div>
      <div className="twk-sect">布局密度 · Density</div>
      <SegmentedRadio
        value={tweaks.density}
        options={["compact", "regular", "cozy"]}
        onChange={(v) => setTweak("density", v as Density)}
      />
      <div className="twk-sect">品牌色调 · Palette</div>
      <PaletteChips value={tweaks.palette} options={PALETTES} onChange={(v) => setTweak("palette", v as Palette)} />
      <div className="twk-sect">侧栏样式 · Sidebar</div>
      <SegmentedRadio
        value={tweaks.sidebar}
        options={["rich", "minimal", "activity"]}
        onChange={(v) => setTweak("sidebar", v as SidebarMode)}
      />
    </>
  );
}

// ── 时间线日报设置 ─────────────────────────────────────────────────────────

function Field({
  label,
  value,
  onChange,
  placeholder,
  type = "text",
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  type?: "text" | "password";
}) {
  return (
    <label className="pw-set-field">
      <span className="pw-set-lbl">{label}</span>
      <input
        className="pw-set-input"
        type={type}
        value={value}
        placeholder={placeholder}
        onChange={(e) => onChange(e.target.value)}
        spellCheck={false}
      />
    </label>
  );
}

// 集成 Agent 列表（与会话创建可选的 agent 一致,来自 AGENT_MODELS 注册表;
// 新增 agent 接入后此处自动出现）。
const AGENT_LABEL: Record<AgentKind, string> = { claude: "Claude Code", codex: "Codex" };
const INTEGRATED_AGENTS = Object.keys(AGENT_MODELS) as AgentKind[];

function Select({
  label,
  value,
  options,
  onChange,
}: {
  label: string;
  value: string;
  options: { label: string; value: string }[];
  onChange: (v: string) => void;
}) {
  return (
    <label className="pw-set-field">
      <span className="pw-set-lbl">{label}</span>
      <select className="pw-set-input" value={value} onChange={(e) => onChange(e.target.value)}>
        {options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
    </label>
  );
}

function TimelineSection() {
  const settings = usePersonalStore((s) => s.timelineSettings);
  const setSettings = usePersonalStore((s) => s.setTimelineSettings);
  const model = settings.summaryModel;
  const setModel = (m: SummaryModelConfig) => setSettings({ summaryModel: m });

  return (
    <>
      <div className="pw-dlg-title">时间线</div>
      <div className="pw-dlg-desc">配置 AI 日报的生成模型。推送渠道在「推送」设置中统一管理。</div>

      <div className="twk-sect">日报生成模型</div>
      <SegmentedRadio
        value={model.kind === "agent" ? "集成 Agent" : "自定义模型"}
        options={["集成 Agent", "自定义模型"]}
        onChange={(v) =>
          setModel(
            v === "集成 Agent"
              ? { kind: "agent", agent: "claude", model: "haiku" }
              : { kind: "openai", baseUrl: "http://localhost:11434", apiKey: "", model: "" },
          )
        }
      />
      {model.kind === "agent" ? (
        <div className="pw-set-group">
          <div className="pw-set-hint">从已集成的 Agent 中选择,按所选 Agent 提供对应的模型列表。</div>
          <div className="pw-set-row2">
            <Select
              label="Agent"
              value={model.agent}
              options={INTEGRATED_AGENTS.map((a) => ({ label: AGENT_LABEL[a], value: a }))}
              onChange={(v) => {
                const agent = v as AgentKind;
                // 切换 agent 时模型重置为该 agent 的默认值。
                setModel({ kind: "agent", agent, model: DEFAULT_MODEL[agent] });
              }}
            />
            <Select
              label="模型"
              value={model.model ?? DEFAULT_MODEL[model.agent]}
              options={AGENT_MODELS[model.agent]}
              onChange={(v) => setModel({ kind: "agent", agent: model.agent, model: v })}
            />
          </div>
        </div>
      ) : (
        <div className="pw-set-group">
          <div className="pw-set-hint">OpenAI 兼容接口（Ollama / LM Studio / vLLM 等本地模型均可）。</div>
          <Field
            label="Base URL"
            value={model.baseUrl}
            placeholder="http://localhost:11434"
            onChange={(v) => setModel({ ...model, baseUrl: v })}
          />
          <Field
            label="模型名"
            value={model.model}
            placeholder="qwen3:14b"
            onChange={(v) => setModel({ ...model, model: v })}
          />
          <Field
            label="API Key（可选）"
            value={model.apiKey ?? ""}
            type="password"
            onChange={(v) => setModel({ ...model, apiKey: v })}
          />
        </div>
      )}
    </>
  );
}

// 全局推送渠道：所有需要推送的场景（当前为时间线日报,未来任务通知等）共用。
function PushSection() {
  const push = usePersonalStore((s) => s.pushSettings);
  const setPush = usePersonalStore((s) => s.setPushSettings);
  const { wecom, dingtalk, email } = push;

  const setWecom = (patch: Partial<WecomPushConfig>) =>
    setPush({ wecom: { enabled: false, webhookUrl: "", ...wecom, ...patch } });
  const setDingtalk = (patch: Partial<DingtalkPushConfig>) =>
    setPush({ dingtalk: { enabled: false, webhookUrl: "", ...dingtalk, ...patch } });
  const setEmail = (patch: Partial<EmailPushConfig>) =>
    setPush({
      email: {
        enabled: false,
        smtpHost: "",
        smtpPort: 465,
        secure: true,
        user: "",
        pass: "",
        from: "",
        to: "",
        ...email,
        ...patch,
      },
    });

  return (
    <>
      <div className="pw-dlg-title">推送渠道</div>
      <div className="pw-dlg-desc">全局推送配置,启用后可在任何支持推送的功能中使用（如时间线日报）。</div>
      <div className="pw-set-group">
        <Toggle label="企业微信机器人" value={!!wecom?.enabled} onChange={(v) => setWecom({ enabled: v })} />
        {wecom?.enabled ? (
          <Field
            label="Webhook 地址"
            value={wecom.webhookUrl}
            placeholder="https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=…"
            onChange={(v) => setWecom({ webhookUrl: v })}
          />
        ) : null}
      </div>
      <div className="pw-set-group">
        <Toggle label="钉钉机器人" value={!!dingtalk?.enabled} onChange={(v) => setDingtalk({ enabled: v })} />
        {dingtalk?.enabled ? (
          <>
            <Field
              label="Webhook 地址"
              value={dingtalk.webhookUrl}
              placeholder="https://oapi.dingtalk.com/robot/send?access_token=…"
              onChange={(v) => setDingtalk({ webhookUrl: v })}
            />
            <Field
              label="加签密钥（可选）"
              value={dingtalk.secret ?? ""}
              type="password"
              placeholder="SEC…（机器人安全设置为「加签」时填写）"
              onChange={(v) => setDingtalk({ secret: v })}
            />
          </>
        ) : null}
      </div>
      <div className="pw-set-group">
        <Toggle label="邮件（SMTP）" value={!!email?.enabled} onChange={(v) => setEmail({ enabled: v })} />
        {email?.enabled ? (
          <>
            <div className="pw-set-row2">
              <Field label="SMTP 服务器" value={email.smtpHost} placeholder="smtp.qq.com" onChange={(v) => setEmail({ smtpHost: v })} />
              <Field
                label="端口"
                value={String(email.smtpPort || "")}
                placeholder="465"
                onChange={(v) => setEmail({ smtpPort: Number(v) || 0 })}
              />
            </div>
            <Toggle label="SSL（465 端口开启,587 关闭）" value={email.secure} onChange={(v) => setEmail({ secure: v })} />
            <div className="pw-set-row2">
              <Field label="账号" value={email.user} onChange={(v) => setEmail({ user: v })} />
              <Field label="密码 / 授权码" value={email.pass} type="password" onChange={(v) => setEmail({ pass: v })} />
            </div>
            <div className="pw-set-row2">
              <Field label="发件人" value={email.from} placeholder="留空使用账号" onChange={(v) => setEmail({ from: v })} />
              <Field label="收件人" value={email.to} placeholder="多个用逗号分隔" onChange={(v) => setEmail({ to: v })} />
            </div>
          </>
        ) : null}
      </div>
    </>
  );
}

export function SettingsDialog({ onClose }: { onClose: () => void }) {
  const [tab, setTab] = useState<SettingsTab>("pet");

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <div className="pw-dlg-overlay" onClick={onClose}>
      <div className="pw-dlg" role="dialog" aria-label="设置" onClick={(e) => e.stopPropagation()}>
        <nav className="pw-dlg-nav">
          <div className="pw-dlg-nav-h">设置</div>
          {TABS.map((t) => (
            <button
              key={t.id}
              className={`pw-dlg-nav-item ${tab === t.id ? "is-active" : ""}`}
              onClick={() => setTab(t.id)}
            >
              {t.icon}
              {t.label}
            </button>
          ))}
        </nav>
        <div className="pw-dlg-body">
          <button className="pw-dlg-x" title="关闭" onClick={onClose}>
            <Icon.X size={15} />
          </button>
          {tab === "pet" ? (
            <PetSection />
          ) : tab === "appearance" ? (
            <AppearanceSection />
          ) : tab === "timeline" ? (
            <TimelineSection />
          ) : (
            <PushSection />
          )}
        </div>
      </div>
    </div>
  );
}

export function SettingsMenu() {
  const [open, setOpen] = useState(false);
  return (
    <div className="sb-foot">
      <button className={`sb-row is-mute ${open ? "is-active" : ""}`} onClick={() => setOpen(true)}>
        <Icon.Settings size={15} />
        <span className="label">设置</span>
      </button>
      {open ? <SettingsDialog onClose={() => setOpen(false)} /> : null}
    </div>
  );
}
