// 自动化「完成后推送」：在主进程收尾处(runner.finalize)按 notify + 终态分发到
// 全局启用的渠道。无头执行(关窗仍跑)决定了推送必须在主进程闭环,不能走渲染端日报路径。
//
// - 外部 webhook/邮件:复用 ipc/push.ts 的 sendPush 与 core 的 enabledPushTargets(纯函数)。
// - 内部通知:Electron 原生系统通知(关窗/最小化也能收到),与渲染端的应用内 toast 互补。
// 推送为 fire-and-forget,失败仅记日志(脱敏:只记自动化名/状态/sendPush 已清洗的错误,
// 绝不打印 target/URL/密钥),绝不影响 run 收尾。

import { BrowserWindow, Notification } from "electron";
import { enabledPushTargets } from "@cortex-work/core/personal/push";
import { getPersistedState } from "../ipc/store";
import { sendPush } from "../ipc/push";
import type { AutomationMeta, AutomationRun, PushChannelKind } from "../ipc/types";
import { createLogger } from "../log";

const log = createLogger("automation-push");

// 完成后推送的终态:成功与各类失败都通知;running/skipped 不通知(并发去重非用户关心的终态)。
const PUSH_STATUSES: ReadonlySet<AutomationRun["status"]> = new Set(["ok", "error", "timeout", "killed"]);

export function isTerminalPushStatus(status: AutomationRun["status"]): boolean {
  return PUSH_STATUSES.has(status);
}

// 全部渠道(legacy 兼容用):旧档曾用布尔 notify=true 表示「推所有启用渠道」。
const ALL_CHANNELS: PushChannelKind[] = ["wecom", "dingtalk", "feishu", "email", "internal"];

// 解析该自动化「完成后通知」要推送的渠道。优先 notifyChannels;为兼容尚未迁移的旧档,
// 旧布尔字段 notify===true 视为「全部渠道」。返回空数组 = 不通知。
export function resolveNotifyChannels(meta: AutomationMeta): PushChannelKind[] {
  if (meta.notifyChannels) return meta.notifyChannels;
  const legacy = (meta as { notify?: boolean }).notify;
  return legacy ? ALL_CHANNELS : [];
}

// 单条推送正文上限(避免超长输出撑爆 webhook/通知)。
const MAX_PUSH_TEXT = 4000;

// 由 run 构造推送内容(纯函数)。text 为原始输出,不前置 subject —— pushWecom 会
// replace 掉首个 subject 子串,前置会被它删除;各渠道在自身侧处理标题展示。
export function formatAutomationPush(meta: AutomationMeta, run: AutomationRun): { subject: string; text: string } {
  const ok = run.status === "ok";
  const subject = ok ? `✅ ${meta.name}` : `⚠️ ${meta.name} 执行失败`;
  const raw = (ok ? run.output : run.error) ?? "";
  const clipped = raw.length > MAX_PUSH_TEXT ? `${raw.slice(0, MAX_PUSH_TEXT)}…` : raw;
  // 成功但无输出 / 失败但无错误信息时,回退用标题兜底,避免推空正文。
  return { subject, text: clipped.trim() || subject };
}

// 主进程原生系统通知。close-to-tray 下窗口可能是 hidden,点击需 show() 再 focus()。
function showAutomationNotification(subject: string, body: string): void {
  if (!Notification.isSupported()) return;
  const n = new Notification({ title: subject, body: body.slice(0, 200) });
  n.on("click", () => {
    const win = BrowserWindow.getAllWindows()[0];
    if (win) {
      win.show();
      win.focus();
    }
  });
  n.show();
}

// 完成后推送调度:读全局 pushSettings → 外部渠道逐个 sendPush + 内部原生通知。
// 整体 try/catch 吞错(读盘失败等),保证不冒泡影响 finalize。
export async function dispatchAutomationPush(meta: AutomationMeta, run: AutomationRun): Promise<void> {
  try {
    const selected = new Set(resolveNotifyChannels(meta));
    if (selected.size === 0) return; // 未选任何渠道 = 不通知
    // 异步读持久化态:命中主进程内存镜像 cached 直接返回,未命中(关窗/重启首次)读盘。
    const { pushSettings } = await getPersistedState();
    if (!pushSettings) return;
    const payload = formatAutomationPush(meta, run);

    // 仅推「该自动化选中」且「全局已配置/启用」的外部渠道(两者取交集)。
    const targets = enabledPushTargets(pushSettings).filter(({ target }) => selected.has(target.kind));
    await Promise.all(
      targets.map(async ({ label, target }) => {
        try {
          const res = await sendPush(target, payload);
          if (!res.ok) {
            log.error(`${meta.name} → ${label} 失败(${run.status}):${res.error ?? "未知"}`);
          }
        } catch (err) {
          log.error(
            `${meta.name} → ${label} 异常:${err instanceof Error ? err.message : String(err)}`,
          );
        }
      }),
    );

    // 内部原生通知:需该自动化选中 internal 且全局内部通知开启。
    if (selected.has("internal") && pushSettings.internal?.enabled) {
      showAutomationNotification(payload.subject, payload.text);
    }
  } catch (err) {
    log.error(`${meta.name} 推送调度异常:${err instanceof Error ? err.message : String(err)}`);
  }
}
