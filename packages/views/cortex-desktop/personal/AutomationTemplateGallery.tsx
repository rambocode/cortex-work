// 自动化「默认模板」画廊：把 AUTOMATION_TEMPLATES 渲染成可点击的卡片网格。
// 每张卡片 = 图标 + 标题 + 一行截断描述,hover 高亮,点击/Enter 触发 onPick。
//
// 跨组件契约（U6 依赖）：本组件只负责「展示 + 把被点的 template 原样上抛」,
// 不做 once 的 at 计算、不做任何草稿转换——由 AutomationView(U6) 负责。

import { Icon } from "@cortex-work/ui/icons";
import { AUTOMATION_TEMPLATES, type AutomationTemplate } from "./automationTemplates";

export function AutomationTemplateGallery({ onPick }: { onPick: (t: AutomationTemplate) => void }) {
  return (
    <div className="pw-auto-tpl-grid" role="list" aria-label="自动化模板">
      {AUTOMATION_TEMPLATES.map((tpl) => {
        // icon 字段被类型约束为 Icon 集合里的合法键,这里安全取用。
        const IconCmp = Icon[tpl.icon];
        return (
          <div
            key={tpl.id}
            className="pw-auto-tpl-card"
            role="listitem"
          >
            <button
              type="button"
              className="pw-auto-tpl-btn"
              onClick={() => onPick(tpl)}
              title={tpl.description}
            >
              <span className="pw-auto-tpl-ico">
                <IconCmp size={16} />
              </span>
              <span className="pw-auto-tpl-body">
                <span className="pw-auto-tpl-name">{tpl.name}</span>
                <span className="pw-auto-tpl-desc">{tpl.description}</span>
              </span>
            </button>
          </div>
        );
      })}
    </div>
  );
}
