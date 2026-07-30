// Provider 认证 IPC 域（阶段②）：API Key / OAuth / 自定义 Provider 与 Secret。
//
// ⚠️ 骨架占位 —— 待实现（实现计划 §3）。
// 红线：renderer 只能拿到 configured/type/source/error，**永不**接触明文或密文；
// 凭据、OAuth code、Header、token 不得进入日志、traces、argv 或错误详情。

import { ipcMain } from "electron";

import { PROVIDER_IPC } from "../providers/contract";
import type {
  CustomProviderDefinition,
  CustomProviderValidation,
  ProviderAuthSnapshot,
  ProviderConnectionTestResult,
} from "../providers/contract";

const NOT_IMPLEMENTED = "provider auth not implemented";

/** 注册认证与自定义 Provider 通道。 */
export function registerProviderAuthHandlers(): void {
  ipcMain.handle(
    PROVIDER_IPC.authStatus,
    (): ProviderAuthSnapshot => ({
      statuses: [],
      health: { available: false, reason: NOT_IMPLEMENTED },
      hiddenProviderIds: [],
    }),
  );
  ipcMain.handle(PROVIDER_IPC.authLogin, () => ({ ok: false, error: NOT_IMPLEMENTED }));
  ipcMain.handle(PROVIDER_IPC.authRespond, () => ({ ok: false, error: NOT_IMPLEMENTED }));
  ipcMain.handle(PROVIDER_IPC.authCancel, () => ({ ok: false, error: NOT_IMPLEMENTED }));
  ipcMain.handle(PROVIDER_IPC.authLogout, () => ({ ok: false, error: NOT_IMPLEMENTED }));
  ipcMain.handle(PROVIDER_IPC.authSetApiKey, () => ({ ok: false, error: NOT_IMPLEMENTED }));
  ipcMain.handle(PROVIDER_IPC.authSetSecrets, () => ({ ok: false, error: NOT_IMPLEMENTED }));
  ipcMain.handle(PROVIDER_IPC.authSetHidden, () => ({ ok: false, error: NOT_IMPLEMENTED }));
  ipcMain.handle(
    PROVIDER_IPC.connectionTest,
    (): ProviderConnectionTestResult => ({ ok: false, error: NOT_IMPLEMENTED }),
  );
  ipcMain.handle(PROVIDER_IPC.customList, (): CustomProviderDefinition[] => []);
  ipcMain.handle(PROVIDER_IPC.customSave, () => ({ ok: false, error: NOT_IMPLEMENTED }));
  ipcMain.handle(PROVIDER_IPC.customDelete, () => ({ ok: false, error: NOT_IMPLEMENTED }));
  ipcMain.handle(
    PROVIDER_IPC.customValidate,
    (): CustomProviderValidation => ({ ok: false, errors: [{ message: NOT_IMPLEMENTED }] }),
  );
}
