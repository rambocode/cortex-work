// 模型 + 推理强度合并为单个 pill(效果图 Image #3),减少 composer 底部占用。
// 触发器紧凑显示「<模型> <推理>」;上弹菜单为「单面板二级下钻」:一级展示推理强度(内联单选)
// + 「模型」入口行;点入口后,同一面板原地切换为模型列表(带返回头),始终锚在 pill 上 —— 只有
// 一个盒子,不再有左右/上下错位的 flyout「割裂」感,也为后续「搜索 + 长模型列表」留出整块空间。
// 兼容两类 agent:claude/codex 走 models/model/onChangeModel;pi 走 piModelOptions/piModelValue/onChangePiModel。

import { useEffect, useState } from "react";
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
  // 是否已下钻到「模型」层(单面板二级:false=推理+入口,true=模型列表)。
  const [modelSub, setModelSub] = useState(false);

  // 主菜单关闭时复位下钻态,避免下次打开残留在模型层。
  useEffect(() => {
    if (!menu.open) setModelSub(false);
  }, [menu.open]);

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
        {currentModelLabel}
        {reasoningShort ? <span className="pw-mt-reason">{reasoningShort}</span> : null}
        <Icon.Chevron size={11} className="chev" />
      </button>
      {menu.open ? (
        <div className="pw-tb-menu pw-tb-menu--up pw-mt-menu" role="menu">
          {modelSub ? (
            /* 模型层:返回头 + 模型列表(原地替换一级内容,后续可在头下加搜索框)。 */
            <>
              <button type="button" className="pw-tb-menu-item pw-mt-back" onClick={() => setModelSub(false)}>
                <Icon.ChevronLeft size={14} />
                <span>{t("composer.modelHeader")}</span>
              </button>
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
            </>
          ) : (
            /* 一级:推理强度(内联单选,✓ 标当前)+ 「模型」入口行(点击下钻)。 */
            <>
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
              <div className="pw-tb-menu-head">{t("composer.modelHeader")}</div>
              <button
                type="button"
                className="pw-tb-menu-item"
                aria-haspopup="menu"
                aria-expanded={modelSub}
                onClick={() => setModelSub(true)}
              >
                <span>{currentModelLabel}</span>
                <Icon.ChevronRight size={14} />
              </button>
            </>
          )}
        </div>
      ) : null}
    </span>
  );
}
