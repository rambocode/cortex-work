// 「自定义供应商」分区：已保存条目的行式列表 + 虚线「添加」入口。
//
// 添加走预制表单（CustomProviderForm，对齐原型：预设 chips + 名称/协议/Base URL/Key/模型 ID
// + 显式能力声明），编辑已有条目走完整 JSON 编辑器（CustomProviderEditor）；表单里也可以
// 一键切到 JSON 模式（带草稿）。列表行展示的是 parseCustomProvider 解析后的形状
//（名称 / 模型数 / Base URL / API 协议）；解析失败或能力字段不全的条目标「配置不完整」——
// 刻意不猜、不兜底（事故根因红线，见 useProviderData.parseCustomProvider 文件头）。
// 每行还带一条「在聊天中是否可用」的状态提示（CustomProviderChatAvailability），把设置页与
// 聊天模型选择器打通，避免用户保存完不知道去哪用、或不知道为什么选择器里没有它。

import { useState } from "react";
import { useTranslation } from "@cortex-work/core/i18n";
import type { CatalogProvider, CustomProviderDefinition } from "@cortex-work/core/desktop/provider-catalog";
import { CustomProviderEditor } from "./CustomProviderPanel";
import { CustomProviderForm } from "./CustomProviderForm";
import { GatewayWizard } from "./GatewayWizard";
import { ProviderTestControl } from "./ProviderTestControl";
import { parseCustomProvider, useCustomProviderActions, useCustomProviders } from "./useProviderData";

/**
 * 分区的编辑态：收起 / 预制表单（新增） / 聚合网关向导 / JSON 编辑器（编辑已有条目或从前两者切过来）。
 * 三条新增路径最终都落到同一份 provider-custom.json —— 网关向导只是「生成器前端」，
 * 存储与运行时零新概念（方案 §B3.4）。
 */
type EditingState =
  | null
  | { mode: "form" }
  | { mode: "gateway" }
  | { mode: "json"; def?: CustomProviderDefinition };

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
              <CustomProviderChatAvailability parsed={parsed} />
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
      ) : editing?.mode === "gateway" ? (
        <div className="pw-pip-editor">
          <GatewayWizard
            storageAvailable={storageAvailable}
            onClose={() => setEditing(null)}
            // 网关向导的「高级」出口：不带草稿(能力必须由主进程解析,渲染端没有可预填的内容)。
            onSwitchToJson={() => setEditing({ mode: "json" })}
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
        <div className="pw-pip-addrow">
          <button type="button" className="pw-pip-add" onClick={() => setEditing({ mode: "form" })}>
            {t("providers.inline.addCustom")}
          </button>
          <button type="button" className="pw-pip-add" onClick={() => setEditing({ mode: "gateway" })}>
            {t("providers.inline.addGateway")}
          </button>
        </div>
      )}
    </div>
  );
}

/**
 * 行内「在聊天中是否可用」状态条：消除「保存了但不知道在哪用」的断层。
 *
 * 判据必须与 useProviderData.collectModelOptions 完全一致——那里是模型选择器的真实取数口，
 * 只有 parseCustomProvider 解析成功且**至少一条模型通过能力校验**的 Provider 才会进候选集。
 * 所以这里不做任何额外的宽松判断，否则会出现「设置页说可用、选择器里找不到」的更糟断层。
 *
 * 两种不可用分开提示：JSON 压根解析不了（parsed === undefined）vs 解析成功但模型全被能力
 * 校验丢弃（models 为空）——两者的排查方向完全不同，合并成一句会让用户白折腾。
 */
function CustomProviderChatAvailability({ parsed }: { parsed: CatalogProvider | undefined }) {
  const { t } = useTranslation("settings");

  if (parsed && parsed.models.length > 0) {
    return <span className="pw-pip-row-hint">{t("providers.inline.chatReady", { count: parsed.models.length })}</span>;
  }
  return (
    <div className="pw-prov-alert is-warn">
      {parsed ? t("providers.inline.chatUnusableModels") : t("providers.inline.chatUnusableParse")}
    </div>
  );
}
