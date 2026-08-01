// 「自定义供应商」分区：已保存条目的行式列表 + 虚线「添加」入口。
//
// 添加走预制表单（CustomProviderForm，对齐原型：预设 chips + 名称/协议/Base URL/Key/模型 ID
// + 显式能力声明），编辑已有条目走完整 JSON 编辑器（CustomProviderEditor）；表单里也可以
// 一键切到 JSON 模式（带草稿）。列表行展示的是 parseCustomProvider 解析后的形状
//（名称 / 模型数 / Base URL / API 协议）；解析失败或能力字段不全的条目标「配置不完整」——
// 刻意不猜、不兜底（事故根因红线，见 useProviderData.parseCustomProvider 文件头）。

import { useState } from "react";
import { useTranslation } from "@cortex-work/core/i18n";
import type { CustomProviderDefinition } from "@cortex-work/core/desktop/provider-catalog";
import { CustomProviderEditor } from "./CustomProviderPanel";
import { CustomProviderForm } from "./CustomProviderForm";
import { ProviderTestControl } from "./ProviderTestControl";
import { parseCustomProvider, useCustomProviderActions, useCustomProviders } from "./useProviderData";

/** 分区的编辑态：收起 / 预制表单（新增） / JSON 编辑器（编辑已有条目或表单切换过来）。 */
type EditingState = null | { mode: "form" } | { mode: "json"; def?: CustomProviderDefinition };

export function PiCustomProviderSection({
  storageAvailable,
  /** 供应商总览行的搜索串：与内建分区共用一份输入，这里按 id/名称过滤列表。 */
  query,
}: {
  storageAvailable: boolean;
  query: string;
}) {
  const { t } = useTranslation("settings");
  const { items } = useCustomProviders();
  const { remove } = useCustomProviderActions();
  const [editing, setEditing] = useState<EditingState>(null);
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);

  const q = query.trim().toLowerCase();
  const rows = items
    .map((def) => ({ def, parsed: parseCustomProvider(def) }))
    .filter(
      (r) => !q || r.def.id.toLowerCase().includes(q) || (r.parsed?.name ?? "").toLowerCase().includes(q),
    );

  // 搜索无命中且没有编辑器打开时整区隐藏（与内建分区的空区隐藏规则一致）。
  if (q && rows.length === 0 && !editing) return null;

  return (
    <div className="pw-pip-sec">
      <div className="pw-pip-sec-h">
        <span className="pw-pip-sec-t">{t("providers.inline.customTitle")}</span>
        <span className="pw-pip-sec-d">{t("providers.inline.customDesc")}</span>
      </div>

      {rows.length > 0 ? (
        <div className="pw-pip-table">
          {rows.map(({ def, parsed }) => (
            <div key={def.id} className="pw-pip-row is-on">
              <div className="pw-pip-row-main">
                <span className={`pw-pip-dot ${parsed && parsed.models.length > 0 ? "is-on" : ""}`} />
                <div className="pw-pip-row-info">
                  <span className="pw-pip-row-name">{parsed?.name ?? def.id}</span>
                  {parsed ? (
                    <span className="pw-prov-badge">{t("providers.badgeModels", { count: parsed.models.length })}</span>
                  ) : (
                    <span className="pw-prov-badge">{t("providers.inline.incomplete")}</span>
                  )}
                </div>
                {parsed?.baseUrl ? <span className="pw-pip-baseurl">{parsed.baseUrl}</span> : null}
                {parsed?.api ? <span className="pw-prov-badge">{parsed.api}</span> : null}
                <span className="pw-pip-spacer" />
                <ProviderTestControl providerId={def.id} modelId={parsed?.models[0]?.id ?? ""} />
                <button type="button" className="pw-pip-linkbtn" onClick={() => setEditing({ mode: "json", def })}>
                  {t("providers.inline.edit")}
                </button>
                <button
                  type="button"
                  className={`pw-pip-linkbtn is-danger ${confirmDeleteId === def.id ? "is-confirming" : ""}`}
                  disabled={remove.isPending}
                  onBlur={() => setConfirmDeleteId(null)}
                  onClick={() =>
                    confirmDeleteId === def.id ? remove.mutate(def.id) : setConfirmDeleteId(def.id)
                  }
                >
                  {confirmDeleteId === def.id ? t("providers.custom.deleteConfirm") : t("providers.custom.delete")}
                </button>
              </div>
            </div>
          ))}
        </div>
      ) : null}

      {editing?.mode === "form" ? (
        <div className="pw-pip-editor">
          <CustomProviderForm
            storageAvailable={storageAvailable}
            onClose={() => setEditing(null)}
            onSwitchToJson={(draft) => setEditing({ mode: "json", def: draft })}
          />
        </div>
      ) : editing?.mode === "json" ? (
        <div className="pw-pip-editor">
          <CustomProviderEditor
            initial={editing.def}
            storageAvailable={storageAvailable}
            onClose={() => setEditing(null)}
          />
        </div>
      ) : (
        <button type="button" className="pw-pip-add" onClick={() => setEditing({ mode: "form" })}>
          {t("providers.inline.addCustom")}
        </button>
      )}
    </div>
  );
}
