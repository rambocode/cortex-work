import type React from "react";

// 设置页共享控件原语(kun 风格:标签/说明在左、控件在右,行间分隔线)。
// 抽自 SettingsMenu.tsx,供 SettingsMenu 自身各分区与 BrowserSettingsSection 共用——
// 二者若互相 import 会循环依赖,故落于此叶子模块(无业务依赖)。

// 设置卡片:标题 + children。
export function SettingCard({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="pw-scard">
      <div className="pw-scard-t">{title}</div>
      {children}
    </div>
  );
}

// 标签在上、内容全宽的块（宽控件用：头像网格 / 宠物造型 / 多字段表单）。
export function SBlock({ label, desc, children }: { label: string; desc?: string; children: React.ReactNode }) {
  return (
    <div className="pw-sblock">
      <div className="pw-sblock-head">
        <span className="pw-srow-lbl">{label}</span>
        {desc ? <span className="pw-srow-desc">{desc}</span> : null}
      </div>
      {children}
    </div>
  );
}

// 左标签/右控件行。
export function SRow({
  label,
  desc,
  children,
  end,
}: {
  label: string;
  desc?: string;
  children: React.ReactNode;
  end?: boolean;
}) {
  return (
    <div className="pw-srow">
      <div className="pw-srow-l">
        <span className="pw-srow-lbl">{label}</span>
        {desc ? <span className="pw-srow-desc">{desc}</span> : null}
      </div>
      <div className={`pw-srow-c ${end ? "pw-srow-c-end" : ""}`}>{children}</div>
    </div>
  );
}

// 总开关行（内嵌 .twk-toggle）。
export function SwitchRow({
  label,
  desc,
  value,
  onChange,
}: {
  label: string;
  desc?: string;
  value: boolean;
  onChange: (v: boolean) => void;
}) {
  return (
    <SRow label={label} desc={desc} end>
      <button
        type="button"
        className="twk-toggle"
        data-on={value ? "1" : "0"}
        role="switch"
        aria-checked={value}
        aria-label={label}
        onClick={() => onChange(!value)}
      >
        <i />
      </button>
    </SRow>
  );
}

// 原生 select 下拉。
export function BareSelect({
  value,
  options,
  onChange,
}: {
  value: string;
  options: { label: string; value: string }[];
  onChange: (v: string) => void;
}) {
  return (
    <select className="pw-set-input" value={value} onChange={(e) => onChange(e.target.value)}>
      {options.map((o) => (
        <option key={o.value} value={o.value}>
          {o.label}
        </option>
      ))}
    </select>
  );
}
