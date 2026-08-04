// 「让 Agent 管理定时任务」总开关。
//
// **挂载位置**：管理页 → MCP 标签，与 ComputerUseSection 并列（见 PluginManagePage.tsx）。
// 理由与 Computer Use 一致：这项能力只在 Cortex（pi）会话中生效，与其它「会话内工具」同类；
// 且**刻意只挂一处** —— 同一个 store 字段若在两个设置界面各有一个开关，用户无从判断哪个作准。
//
// 这里要讲清楚三件事，否则用户既不知道自己有这个能力、也不敢用：
//   1. **它能做什么**：在对话里直接说「每天早上 9 点帮我总结 AI 新闻」就能建好定时任务。
//   2. **改动前会问我吗**：会。新建/修改/删除/立即运行都强制逐次确认，且这道确认不受
//      「工具执行审批」开关影响（见 core/personal/permissionMode.ts 的 ALWAYS_APPROVE_TOOLS）。
//   3. **哪里不生效**：Claude Code / Codex 会话拿不到（它们没有审批回路），定时任务自己跑起来时
//      也拿不到（无人值守的路径给 Agent 建/删定时任务的权限，等于让它无监督自增殖）。
// 第 3 条尤其要写出来：不写的话，用户切到 Claude 发现说了没反应，只会以为功能坏了。

import { usePersonalStore } from "@cortex-work/core";
import { SettingCard, SwitchRow } from "../settings/settingsControls";

export function AutomationToolsSection() {
  const general = usePersonalStore((s) => s.generalSettings);
  const setGeneral = usePersonalStore((s) => s.setGeneralSettings);

  // 缺省视为启用——与主进程 capabilities/automation/server.ts 的 automationToolsEnabled 同口径。
  // 两处必须一致，否则会出现「UI 显示关、实际注入了」这类错位。
  const enabled = general.automationTools?.enabled !== false;

  return (
    <SettingCard title="会话内管理定时任务">
      <SwitchRow
        label="允许 Cortex 在对话中管理定时任务"
        desc="开启后可以直接说「每天早上 9 点帮我总结 AI 新闻」来创建，或问「我有哪些定时任务」来查询。"
        value={enabled}
        onChange={(v) => setGeneral({ automationTools: { ...general.automationTools, enabled: v } })}
      />
      <div className="pw-srow">
        <div className="pw-srow-l">
          <span className="pw-srow-desc">
            新建、修改、删除与立即运行都会先弹确认框，需你点「允许」才生效；查询类操作不打扰。
            仅在 <b>Cortex</b> 会话中生效——Claude Code / Codex 会话以及定时任务自己执行时都不会拿到这些工具。
          </span>
        </div>
      </div>
    </SettingCard>
  );
}
