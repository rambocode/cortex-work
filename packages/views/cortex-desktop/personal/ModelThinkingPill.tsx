// agent(可选)+ 模型 + 推理强度合并为单个 pill(效果图 Image #3),减少 composer 底部占用。
// 触发器紧凑显示「[agent 头像] <模型> <推理短标签> ▾」;菜单默认向下弹出(底部空间不足自动
// 翻上,见 useAutoFlipUp)为级联面板:一级是 Agent(可选)/ 模型 / 推理三行(标签 + 当前值 + ›),
// 鼠标悬停(或点击)行即在右侧展开该维度的二级 flyout(右侧不足自动翻左)——不点下钻、不原地换层。
// agent 维度 opt-in:落地页 composer 传 onSwitchAgent 才有 Agent 行与头像;会话内/写作栏不传
// 时退化为「模型 + 推理」两行(触发器用 lightning 图标),行为与旧版一致。
// agent 列表/门控/选中态规则与 AgentSelect 单一同源(见下方 agentList 注释),两处不漂移。
// 兼容两类 agent:claude/codex 走 models/model/onChangeModel;pi 走 piModelOptions/piModelValue/onChangePiModel。

import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type { ReactNode } from "react";
import { Icon } from "@cortex-work/ui/icons";
import { useTranslation } from "@cortex-work/core/i18n";
import { AGENT_MODELS } from "@cortex-work/core";
import type { AgentKind, AgentThinkingValue, DerivedAgentMeta } from "@cortex-work/core";
import { AGENT_LABEL, agentDisplayAvatar, agentDisplayLabel } from "./agentMeta";
import { useDismissableMenu } from "./useDismissableMenu";
import { useAutoFlipUp } from "./useAutoFlipUp";

interface Opt {
  value: string;
  label: string;
}
interface ThinkingOpt {
  value: AgentThinkingValue;
  labelKey: string;
}

// 当前悬停/点击展开的二级菜单;null = 只有一级行。
type Sub = "agent" | "model" | "thinking";

// 取「思考·中」/「Thinking · Medium」末段为短标签(一级行已有「推理」标签,前缀冗余)。
function shortLabel(full: string): string {
  const seg = full.split("·").pop();
  return (seg ?? full).trim();
}

export function ModelThinkingPill({
  isPi,
  models,
  model,
  onChangeModel,
  piModelOptions,
  piModelValue,
  onChangePiModel,
  thinkingOptions,
  resolvedThinkingValue,
  onChangeThinking,
  disabled,
  agent,
  derivedAgentId,
  agentsAvailable,
  derivedAgents,
  onSwitchAgent,
}: {
  isPi: boolean;
  models: Opt[];
  model: string | undefined;
  onChangeModel: (model: string) => void;
  piModelOptions: Opt[];
  piModelValue: string;
  onChangePiModel: (providerId: string, model: string) => void;
  thinkingOptions: ThinkingOpt[];
  resolvedThinkingValue: AgentThinkingValue;
  onChangeThinking?: (value: AgentThinkingValue) => void;
  disabled?: boolean;
  // ── agent 维度(opt-in,落地页 composer 传入;缺省时面板无 Agent 行) ──
  // 当前选中的内置 base agent(语义同 AgentSelect:draft/session 始终存 base)。
  agent?: AgentKind;
  derivedAgentId?: string;
  agentsAvailable?: Partial<Record<AgentKind, boolean>>;
  derivedAgents?: DerivedAgentMeta[];
  onSwitchAgent?: (agent: AgentKind, derived?: DerivedAgentMeta) => void;
}) {
  const { t } = useTranslation("chat");
  const menu = useDismissableMenu();
  // 垂直方向默认下弹,底部空间不足(历史会话页 composer 贴底)自动翻上。
  const flip = useAutoFlipUp(menu.open);
  const [openSub, setOpenSub] = useState<Sub | null>(null);
  // 二级 flyout 默认右开;实测右缘溢出视口时翻左(见下方 layoutEffect)。
  const [flipLeft, setFlipLeft] = useState(false);
  const subRef = useRef<HTMLDivElement>(null);

  // 主菜单关闭时复位二级展开态,避免下次打开残留在上次的 flyout。
  useEffect(() => {
    if (!menu.open) setOpenSub(null);
  }, [menu.open]);

  // flyout 每次展开后在绘制前测量:右缘越过视口(留 8px 余量)即翻左,同帧改类无可见闪烁;
  // 收起/切换行时复位为默认右开。
  useLayoutEffect(() => {
    if (!openSub) {
      setFlipLeft(false);
      return;
    }
    const el = subRef.current;
    setFlipLeft(!!el && el.getBoundingClientRect().right > window.innerWidth - 8);
  }, [openSub]);

  const modelOpts = isPi ? piModelOptions : models;
  const currentModelValue = isPi ? piModelValue : model || models[0]?.value || "";
  // 当前值找不到匹配项时回退到第一个选项(用户诉求:选默认/第一个);仅在真的无任何选项时才显示
  // 「未配置供应商」。避免「已配 provider 但 value 未对齐」误显示未配置。
  const currentModelOpt = modelOpts.find((o) => o.value === currentModelValue) ?? modelOpts[0];
  const currentModelLabel =
    currentModelOpt?.label ?? (isPi ? t("composer.noProvider") : "");
  const effectiveModelValue = currentModelOpt?.value ?? currentModelValue;

  const currentThinking = thinkingOptions.find((o) => o.value === resolvedThinkingValue);
  const reasoningShort = currentThinking ? shortLabel(t(currentThinking.labelKey)) : "";

  // agent 维度的当前展示:派生优先(显示派生名/头像),否则内置 base —— 与 AgentSelect 同规则。
  const agentKey = derivedAgentId ?? agent ?? "pi";
  const agentAvatar = agentDisplayAvatar(agentKey, derivedAgents);
  const agentLabel = agentDisplayLabel(agentKey, derivedAgents);

  const selectModel = (value: string) => {
    if (isPi) {
      const [providerId, m] = value.split("::");
      onChangePiModel(providerId ?? "", m ?? "");
    } else {
      onChangeModel(value);
    }
    menu.setOpen(false);
  };

  // agent 二级列表:列表/门控/选中态规则照搬 AgentSelect —— 内置三项(非 pi 未安装禁用并标注,
  // pi 永不置灰)+ 过滤内置同名 id 后的新派生;选中态「派生优先、内置需无 derivedAgentId」。
  const agentList = (
    <>
      {(Object.keys(AGENT_MODELS) as AgentKind[]).map((a) => {
        const unavailable = a !== "pi" && agentsAvailable?.[a] === false;
        return (
          <button
            key={a}
            className="pw-tb-menu-item"
            role="menuitem"
            disabled={unavailable}
            onClick={() => {
              if (unavailable) return;
              onSwitchAgent?.(a);
              menu.setOpen(false);
            }}
          >
            <span>
              {AGENT_LABEL[a]}
              {unavailable ? "（未安装）" : ""}
            </span>
            {a === agent && !derivedAgentId ? <Icon.Check size={14} /> : null}
          </button>
        );
      })}
      {(derivedAgents ?? [])
        .filter((d) => !(["claude", "codex", "pi"] as readonly string[]).includes(d.id))
        .map((d) => (
          <button
            key={d.id}
            className="pw-tb-menu-item"
            role="menuitem"
            onClick={() => {
              onSwitchAgent?.(d.base, d);
              menu.setOpen(false);
            }}
          >
            <span>{d.label ?? d.id}</span>
            {d.id === derivedAgentId ? <Icon.Check size={14} /> : null}
          </button>
        ))}
    </>
  );

  // 模型二级列表:.pw-mt-models 限高内部滚动承载长模型列表/后续搜索。
  const modelList = (
    <div className="pw-mt-models">
      {modelOpts.length === 0 ? (
        <button type="button" className="pw-tb-menu-item" disabled>
          <span>{t("composer.noProvider")}</span>
        </button>
      ) : (
        modelOpts.map((o) => (
          <button
            key={o.value}
            type="button"
            className="pw-tb-menu-item"
            role="menuitemradio"
            aria-checked={o.value === effectiveModelValue}
            onClick={() => selectModel(o.value)}
          >
            <span>{o.label}</span>
            {o.value === effectiveModelValue ? <Icon.Check size={14} /> : null}
          </button>
        ))
      )}
    </div>
  );

  // 推理二级列表:单选,选中即关菜单。
  const thinkingList = thinkingOptions.map((o) => (
    <button
      key={o.value}
      type="button"
      className="pw-tb-menu-item"
      role="menuitemradio"
      aria-checked={o.value === resolvedThinkingValue}
      onClick={() => {
        onChangeThinking?.(o.value);
        menu.setOpen(false);
      }}
    >
      <span>{shortLabel(t(o.labelKey))}</span>
      {o.value === resolvedThinkingValue ? <Icon.Check size={14} /> : null}
    </button>
  ));

  // 一级行:标签 + 当前值 + ›;悬停(或点击)在行的左侧展开对应二级 flyout。
  // flyout 渲染在行包裹层内 —— 从行移进 flyout 不离开 hover 域,指针路径上不会闪关。
  const subRow = (target: Sub, label: string, value: string, list: ReactNode) => (
    <div key={target} className="pw-mt-row-wrap" onMouseEnter={() => setOpenSub(target)}>
      <button
        type="button"
        className="pw-tb-menu-item pw-mt-row"
        aria-haspopup="menu"
        aria-expanded={openSub === target}
        onClick={() => setOpenSub(target)}
      >
        <span>{label}</span>
        <span className="pw-mt-row-value">
          {value}
          <Icon.ChevronRight size={14} />
        </span>
      </button>
      {openSub === target ? (
        <div ref={subRef} className={`pw-tb-menu pw-mt-sub${flipLeft ? " pw-mt-sub--left" : ""}`} role="menu">
          {list}
        </div>
      ) : null}
    </div>
  );

  return (
    <span
      className="pill pw-model-pill pw-mt-pill"
      ref={menu.wrapRef}
      onMouseLeave={menu.onMouseLeave}
      onMouseEnter={menu.onMouseEnter}
    >
      <button
        type="button"
        className="pw-mt-trigger"
        onClick={() => menu.setOpen((v) => !v)}
        // disabled(未配置模型)不锁死 agent 切换入口:有 onSwitchAgent 时 pill 保持可点,
        // 只让模型层自己显示「未配置供应商」——旧 AgentSelect 在此场景下本就可用,不回退该能力。
        disabled={disabled && !onSwitchAgent}
        aria-haspopup="menu"
        aria-expanded={menu.open}
      >
        {onSwitchAgent ? (
          <span className="pw-mt-avatar" style={{ background: agentAvatar.bg }}>
            {agentAvatar.initials}
          </span>
        ) : (
          <span className="lightning">
            <Icon.Lightning size={11} />
          </span>
        )}
        {currentModelLabel}
        {reasoningShort ? <span className="pw-mt-reason">{reasoningShort}</span> : null}
        <Icon.Chevron size={11} className="chev" />
      </button>
      {menu.open ? (
        <div
          ref={flip.menuRef}
          className={`pw-tb-menu pw-mt-menu${flip.flipUp ? " pw-tb-menu--up" : ""}`}
          role="menu"
        >
          {onSwitchAgent ? subRow("agent", "Agent", agentLabel, agentList) : null}
          {subRow("model", t("composer.modelHeader"), currentModelLabel, modelList)}
          {thinkingOptions.length && onChangeThinking
            ? subRow("thinking", t("composer.reasoningHeader"), reasoningShort, thinkingList)
            : null}
        </div>
      ) : null}
    </span>
  );
}
