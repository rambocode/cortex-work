// 模型 + 推理强度合并为单个 pill(效果图 Image #3),减少 composer 底部占用。
// 触发器紧凑显示「<模型> <推理>」;上弹菜单:推理强度(内联单选)+ 模型(右侧子菜单)。
// 兼容两类 agent:claude/codex 走 models/model/onChangeModel;pi 走 piModelOptions/piModelValue/onChangePiModel。

import { useState } from "react";
import { Icon } from "@cortex-work/ui/icons";
import { useTranslation } from "@cortex-work/core/i18n";
import type { AgentThinkingValue } from "@cortex-work/core";
import { useDismissableMenu } from "./useDismissableMenu";

interface Opt {
  value: string;
  label: string;
}
interface ThinkingOpt {
  value: AgentThinkingValue;
  labelKey: string;
}

// 取「思考·中」/「Thinking · Medium」末段为短标签(菜单已有「推理」表头,前缀冗余)。
function shortLabel(full: string): string {
  const seg = full.split("·").pop();
  return (seg ?? full).trim();
}
// 模型短名:含「provider · model」时取模型段(pi 选项),否则原样。
function modelShortLabel(full: string): string {
  return full.includes("·") ? full.split("·").pop()!.trim() : full;
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
}) {
  const { t } = useTranslation("chat");
  const menu = useDismissableMenu();
  const [modelSub, setModelSub] = useState(false);

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

  const selectModel = (value: string) => {
    if (isPi) {
      const [providerId, m] = value.split("::");
      onChangePiModel(providerId ?? "", m ?? "");
    } else {
      onChangeModel(value);
    }
    setModelSub(false);
    menu.setOpen(false);
  };

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
        disabled={disabled}
        aria-haspopup="menu"
        aria-expanded={menu.open}
      >
        <span className="lightning">
          <Icon.Lightning size={11} />
        </span>
        {modelShortLabel(currentModelLabel)}
        {reasoningShort ? <span className="pw-mt-reason">{reasoningShort}</span> : null}
        <Icon.Chevron size={11} className="chev" />
      </button>
      {menu.open ? (
        <div className="pw-tb-menu pw-tb-menu--up pw-mt-menu" role="menu">
          {/* 推理强度:内联单选(✓ 标当前)。 */}
          {thinkingOptions.length && onChangeThinking ? (
            <>
              <div className="pw-tb-menu-head">{t("composer.reasoningHeader")}</div>
              {thinkingOptions.map((o) => (
                <button
                  key={o.value}
                  type="button"
                  className="pw-tb-menu-item"
                  role="menuitemradio"
                  aria-checked={o.value === resolvedThinkingValue}
                  onClick={() => {
                    onChangeThinking(o.value);
                    menu.setOpen(false);
                  }}
                >
                  <span>{shortLabel(t(o.labelKey))}</span>
                  {o.value === resolvedThinkingValue ? <Icon.Check size={14} /> : null}
                </button>
              ))}
              <div className="pw-tb-menu-sep" />
            </>
          ) : null}
          {/* 模型:右侧子菜单(点击展开;不用 hover 以免移向子菜单途中误关闭)。 */}
          <div className="pw-submenu-wrap">
            <button
              type="button"
              className="pw-tb-menu-item"
              aria-haspopup="menu"
              aria-expanded={modelSub}
              onClick={() => setModelSub((v) => !v)}
            >
              <span>{currentModelLabel}</span>
              <Icon.ChevronRight size={14} />
            </button>
            {modelSub ? (
              <div className="pw-tb-menu pw-mt-submenu" role="menu">
                <div className="pw-tb-menu-head">{t("composer.modelHeader")}</div>
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
            ) : null}
          </div>
        </div>
      ) : null}
    </span>
  );
}
