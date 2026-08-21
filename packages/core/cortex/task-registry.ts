// 在途分身/服务器工作区任务登记表（模块级单例）：mutations 发起 invoke 后登记
// 「task/turn id → (contactId, contact, generation, conversationId)」，realtime 据此向 WS
// 订阅 task scope 并把定向帧折进正确的会话缓存；终态/取消/代际接管时注销。
// 独立成文件是为了斩断 mutations ↔ realtime 的循环导入：两边都只依赖本模块。
// 不放 Zustand——纯管线状态，UI 不渲染它。

import type { Contact } from "../types";

export interface ActiveTaskBinding {
  contactId: string;
  contact: Contact | undefined;
  generation: number;
  conversationId: string;
}

const activeTasks = new Map<string, ActiveTaskBinding>();
const registryListeners = new Set<(taskId: string, added: boolean) => void>();

export function registerAvatarTask(taskId: string, binding: ActiveTaskBinding): void {
  activeTasks.set(taskId, binding);
  for (const cb of registryListeners) cb(taskId, true);
}

// 幂等注销：未登记的 id 直接忽略（终态可能同时从轮询与 WS 两路到达）。
export function unregisterAvatarTask(taskId: string): void {
  if (!activeTasks.delete(taskId)) return;
  for (const cb of registryListeners) cb(taskId, false);
}

export function getActiveTaskBinding(taskId: string): ActiveTaskBinding | undefined {
  return activeTasks.get(taskId);
}

export function listActiveTaskIds(): string[] {
  return [...activeTasks.keys()];
}

// realtime 挂载时订阅登记变化；返回退订函数。
export function subscribeTaskRegistry(cb: (taskId: string, added: boolean) => void): () => void {
  registryListeners.add(cb);
  return () => registryListeners.delete(cb);
}
