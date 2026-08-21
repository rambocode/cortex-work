// agent(可选)+ 模型 + 推理强度合并为单个 pill(效果图 Image #3),减少 composer 底部占用。
// 触发器紧凑显示「[agent 头像] <模型> <推理短标签> ▾」;菜单默认向下弹出(底部空间不足自动
// 翻上,见 useOverflowSafePlacement)为级联面板:一级是 Agent(可选)/ 模型 / 推理三行(标签 + 当前值 + ›),
// 鼠标悬停(或点击)行即在右侧展开该维度的二级 flyout(右侧不足自动翻左)——不点下钻、不原地换层。
// 二级 flyout **底缘与一级面板底缘对齐**、向上生长(见 subMaxH),这样模型再多也只吃视口上方的空间,
// 不会被窗口下边缘裁掉——旧的「顶缘对齐所属行、向下铺」在贴底的 composer 里必然溢出。
// agent 维度 opt-in:落地页 composer 传 onSwitchAgent 才有 Agent 行与头像;会话内/写作栏不传
// 时退化为「模型 + 推理」两行(触发器用 lightning 图标),行为与旧版一致。
// agent 列表/门控/选中态规则与 AgentSelect 单一同源(见下方 agentList 注释),两处不漂移。
// 兼容两类 agent:claude/codex 走 models/model/onChangeModel;pi 走 piModelOptions/piModelValue/onChangePiModel。

import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type { ReactNode } from "react";
import { Icon } from "@cortex-work/ui/icons";
import { useTranslation } from "@cortex-work/core/i18n";
import type { AgentKind, AgentThinkingValue, DerivedAgentMeta } from "@cortex-work/core";
import { agentDisplayAvatar, agentDisplayLabel } from "../agentMeta";
import { AgentMenuItems } from "../AgentMenuItems";
import { useDismissableMenu } from "../../shared/useDismissableMenu";
import { useOverflowSafePlacement } from "../../shared/useOverflowSafePlacement";

interface Opt {
  value: string;
  label: string;
}
interface ThinkingOpt {
  value: AgentThinkingValue;
  labelKey: string;
}

// 二级 flyout 与视口上边缘的最小留白(与 useOverflowSafePlacement 的 MARGIN 同口径)。
const SUB_VIEWPORT_MARGIN = 8;
// 高度下限:窗口被压得极矮时也别把 flyout 压成一条缝,宁可内部滚动。
const SUB_MIN_HEIGHT = 120;

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
  const [openSub, setOpenSub] = useState<Sub | null>(null);
  // 二级 flyout 与一级面板都走同一套「先翻转、翻不动就钳回视口」的避让
  //（useOverflowSafePlacement）。此前是各写一段只翻转的 layoutEffect，
  // 但窄栏里两侧都不够时翻转失效，用户反复反馈「模型选择右侧显示不全」。
  const subPlace = useOverflowSafePlacement(!!openSub);
  const menuPlace = useOverflowSafePlacement(menu.open);
  // 二级 flyout 的可用高度 = 一级面板底缘到视口顶部(留 SUB_VIEWPORT_MARGIN 边距)。
  // 必须在 menu.open 时(而不是展开二级时)量:面板此刻已渲染且高度固定,先把值备好,
  // flyout 首帧就带着 maxHeight 出现 —— 否则 useOverflowSafePlacement 会先按「未限高的
  // 超长列表」量一次,算出一段多余的钳制位移,再被 maxHeight 推翻,肉眼可见跳一下。
  const subMaxHRef = useRef<number | undefined>(undefined);
  const [subMaxH, setSubMaxH] = useState<number | undefined>(undefined);
  useLayoutEffect(() => {
    if (!menu.open) {
      subMaxHRef.current = undefined;
      setSubMaxH(undefined);
      return;
    }
    const el = menuPlace.ref.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    // 零尺寸 = 还没布局(jsdom 恒为 0),此时算出的高度没有意义,跳过。
    if (r.height === 0) return;
    const next = Math.max(SUB_MIN_HEIGHT, Math.round(r.bottom - SUB_VIEWPORT_MARGIN));
    if (subMaxHRef.current === next) return;
    subMaxHRef.current = next;
    setSubMaxH(next);
  }, [menu.open, menuPlace.ref, menuPlace.flipY, menuPlace.shiftY]);

  // 主菜单关闭时复位二级展开态,避免下次打开残留在上次的 flyout。
  useEffect(() => {
    if (!menu.open) setOpenSub(null);
  }, [menu.open]);

  const modelOpts = isPi ? piModelOptions : models;
  const currentModelValue = isPi ? piModelValue : model || models[0]?.value || "";
  // pi 侧**不做任何回退**（计划 §5）：会话引用的模型在 Catalog 里查不到、或它所属 Provider
  // 未认证 / 被隐藏时，显示「未配置供应商」阻断态并把用户引到设置页，而不是悄悄替换成
  // 「第一个可用模型」——静默换模型会让人以为还在用原配置，实际能力、输出与账单全变了。
  // 非 pi（claude/codex）模型集是内置常量，沿用旧的回退第一个的行为。
  const currentModelOpt = isPi
    ? modelOpts.find((o) => o.value === currentModelValue)
    : (modelOpts.find((o) => o.value === currentModelValue) ?? modelOpts[0]);
  const currentModelLabel =
    currentModelOpt?.label ?? (isPi ? t("composer.noProvider") : "");
  // 触发器上的展示级缩短:带命名空间的模型 id(如 mlx-community/Qwen3.5-…)只显示末段,
  // 全名保留在 title 与下拉菜单里。避免超长模型名把输入框底部一行吃满(清爽化改版)。
  const triggerModelLabel = currentModelLabel.includes("/")
    ? currentModelLabel.slice(currentModelLabel.lastIndexOf("/") + 1)
    : currentModelLabel;
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

  // agent 二级列表:与 AgentSelect 共用 AgentMenuItems —— 候选/门控/选中态/副标题文案单一口径。
  const agentList = (
    <AgentMenuItems
      agent={agent}
      derivedAgentId={derivedAgentId}
      agentsAvailable={agentsAvailable}
      derivedAgents={derivedAgents}
      onSwitch={(a, d) => onSwitchAgent?.(a, d)}
      onClose={() => menu.setOpen(false)}
      checkSize={14}
    />
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
        <div
          ref={subPlace.ref}
          className={`pw-tb-menu pw-mt-sub${subPlace.flipX ? " pw-mt-sub--left" : ""}`}
          style={{ ...subPlace.style, maxHeight: subMaxH }}
          role="menu"
        >
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
        <span title={currentModelLabel === triggerModelLabel ? undefined : currentModelLabel}>
          {triggerModelLabel}
        </span>
        {reasoningShort ? <span className="pw-mt-reason">{reasoningShort}</span> : null}
        <Icon.Chevron size={11} className="chev" />
      </button>
      {menu.open ? (
        <div
          ref={menuPlace.ref}
          className={`pw-tb-menu pw-mt-menu${menuPlace.flipY ? " pw-tb-menu--up" : ""}${
            menuPlace.flipX ? " pw-mt-menu--right" : ""
          }`}
          style={menuPlace.style}
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
