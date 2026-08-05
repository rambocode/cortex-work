// 「聚合网关」顶层分区：与订阅登录 / API Key / 云平台并列的第四类接入形态。
//
// 为什么单独成区（而不是继续埋在「自定义供应商」里）：网关的配置形态与云平台行**同构**
//（填地址 + Key → 拉模型 → 勾选启用），却和「粘贴一整段 Pi Provider JSON」的手工路径挤在
// 同一区，入口还要先点一次「接入聚合网关」才看得见。用户的原话是「不能把 newapi 也做成平台
// 类型吗」—— 对的：new-api / one-api 对用户就是一个平台，不是一份 JSON。
//
// ⚠️⚠️ **存储完全没变，这里只是呈现层重分类** ⚠️⚠️
// 网关供应商仍然是不折不扣的「自定义 Provider」：仍落 `provider-custom.json`，仍走
// `providerCustomSave` / `providerCustomDelete`，仍由 `parseCustomProvider` 解析。分区归属
// 是**运行期按 `isGatewayGenerated`（即定义里有没有 `capabilitySource`）算出来的**，不落盘、
// 没有第二份存储、没有新的 id 命名空间。
// 后人若想「给网关另起一套存储」请先想清楚代价：会话 extension 注入、主进程 pi-ai 注册表、
// Model Gateway 取数、连接测试、模型选择器候选集**全部**挂在 `provider-custom.json` 这一份
// 存储上，换存储等于把整轮接线重做一遍，而用户对此毫无感知（他看到的只是分区标题变了）。
//
// 能力字段仍然零输入：本区没有任何能力控件，能力一律由主进程从随包 Catalog 解析（红线）。

import { useMemo, useState } from "react";
import { useTranslation } from "@cortex-work/core/i18n";
import type { CustomProviderDefinition } from "@cortex-work/core/desktop/provider-catalog";
import { CustomProviderEditor } from "./CustomProviderPanel";
import { CustomProviderChatAvailability } from "./PiCustomProviderSection";
import { GatewayWizard } from "./GatewayWizard";
import { isGatewayGenerated } from "./gatewayDefinition";
import { ModelsPopover } from "./PiProvidersSection";
import { ProviderTestControl } from "./ProviderTestControl";
import {
  parseCustomProvider,
  useCustomProviderActions,
  useCustomProviders,
  useProviderViews,
} from "./useProviderData";

/**
 * 本区的编辑态：收起 / 向导（新增或编辑）/ JSON 编辑器（只从向导的「高级」出口进来）。
 * 两者写的是同一份 provider-custom.json —— 向导只是「生成器前端」。
 */
type GatewayEditing =
  | null
  | { mode: "wizard"; def?: CustomProviderDefinition }
  | { mode: "json"; def?: CustomProviderDefinition };

export function PiGatewaySection({
  storageAvailable,
  /** 供应商总览行的搜索串：与其它分区共用一份输入，这里按 id/名称/接入地址过滤。 */
  query,
}: {
  storageAvailable: boolean;
  query: string;
}) {
  const { t } = useTranslation("settings");
  const { items } = useCustomProviders();
  const { views } = useProviderViews();
  const { remove } = useCustomProviderActions();
  const [editing, setEditing] = useState<GatewayEditing>(null);
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);

  // 「N 模型」浮层要的是 ProviderView。自定义 Provider 已经在 useProviderViews 里合并好了，
  // 这里按 id 取回即可；解析失败的定义在那份列表里没有对应项（下面按「配置不完整」渲染）。
  const viewById = useMemo(
    () => new Map(views.filter((v) => v.custom).map((v) => [v.provider.id, v])),
    [views],
  );

  const q = query.trim().toLowerCase();
  // 行的来源是**定义列表**而不是 views：解析失败的条目在 views 里会被整条丢掉，
  // 只看 views 会让一份坏掉的网关配置在界面上彻底消失，用户连删都删不掉。
  const rows = items
    .filter(isGatewayGenerated)
    .map((def) => ({ def, parsed: parseCustomProvider(def) }))
    .filter(
      (r) =>
        !q ||
        r.def.id.toLowerCase().includes(q) ||
        (r.parsed?.name ?? "").toLowerCase().includes(q) ||
        (r.parsed?.baseUrl ?? "").toLowerCase().includes(q),
    );

  // 搜索无命中且没有编辑器打开时整区隐藏（与内建分区的空区隐藏规则一致）。
  // 注意只在**搜索时**隐藏：没有任何网关时本区照样要在，否则「+ 接入网关」入口就没了。
  if (q && rows.length === 0 && !editing) return null;

  return (
    <div className="pw-pip-sec">
      <div className="pw-pip-sec-h">
        <span className="pw-pip-sec-t">{t("providers.inline.gatewayTitle")}</span>
        <span className="pw-pip-sec-d">{t("providers.inline.gatewayDesc")}</span>
        <span className="pw-pip-spacer" />
        {/* 分区头部直接开向导：接入网关是本区的主操作，不该藏在列表底部或别的分区里。 */}
        <button type="button" className="pw-pip-linkbtn" onClick={() => setEditing({ mode: "wizard" })}>
          {t("providers.inline.gatewayAdd")}
        </button>
      </div>

      {rows.length > 0 ? (
        <div className="pw-pip-table">
          {rows.map(({ def, parsed }) => {
            const view = viewById.get(def.id);
            return (
              <div key={def.id} className="pw-pip-row is-on">
                <div className="pw-pip-row-main">
                  <span className={`pw-pip-dot ${parsed && parsed.models.length > 0 ? "is-on" : ""}`} />
                  <div className="pw-pip-row-info">
                    <span className="pw-pip-row-name">{parsed?.name ?? def.id}</span>
                    {/* 有 view 才用浮层（能连带展示只读能力与来源标注）；解析失败时退成静态徽标。 */}
                    {view ? (
                      <ModelsPopover view={view} />
                    ) : (
                      <span className="pw-prov-badge">{t("providers.inline.incomplete")}</span>
                    )}
                  </div>
                  {parsed?.baseUrl ? <span className="pw-pip-baseurl">{parsed.baseUrl}</span> : null}
                  {parsed?.api ? <span className="pw-prov-badge">{parsed.api}</span> : null}
                  <span className="pw-pip-spacer" />
                  <ProviderTestControl
                    providerId={def.id}
                    modelId={parsed?.models[0]?.id ?? ""}
                    // 网关的地址写在自定义 Provider JSON 里（不走 baseUrl 覆盖），故直接取解析值。
                    context={{
                      providerName: parsed?.name ?? def.id,
                      baseUrl: parsed?.baseUrl,
                      authSource: view?.status.source,
                      authType: view?.status.type,
                    }}
                  />
                  <button
                    type="button"
                    className="pw-pip-linkbtn"
                    onClick={() => setEditing({ mode: "wizard", def })}
                  >
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
            );
          })}
        </div>
      ) : null}

      {editing?.mode === "wizard" ? (
        <div className="pw-pip-editor">
          <GatewayWizard
            storageAvailable={storageAvailable}
            initial={editing.def}
            onClose={() => setEditing(null)}
            // 「高级」出口：新增时不带草稿（能力必须由主进程解析，渲染端没有可预填的内容）；
            // 编辑时必须把当前这份 def 带过去，否则一点「改用 JSON」就变成新建一个空配置。
            onSwitchToJson={() => setEditing({ mode: "json", def: editing.def })}
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
      ) : rows.length === 0 ? (
        // 空态：列表区没有任何行，头部那个链接按钮太轻，补一个虚线主入口。
        <div className="pw-pip-addrow">
          <button type="button" className="pw-pip-add" onClick={() => setEditing({ mode: "wizard" })}>
            {t("providers.inline.addGateway")}
          </button>
        </div>
      ) : null}
    </div>
  );
}
