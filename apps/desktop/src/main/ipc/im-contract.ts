import type { ImPlatformSpec } from "@cortex-work/core/desktop/im-types";

export interface RuntimePlatformSpec {
  platform: ImPlatformSpec["platform"];
  modes: ImPlatformSpec["modes"];
  default_mode: ImPlatformSpec["defaultMode"];
  credential_fields: string[];
}

/** Go 的 snake_case HTTP 契约在 IPC 边界转换，renderer 内只使用 camelCase。 */
export function normalizeImPlatformSpecs(rows: RuntimePlatformSpec[]): ImPlatformSpec[] {
  return rows.map((row) => ({
    platform: row.platform,
    modes: row.modes,
    defaultMode: row.default_mode,
    credentialFields: row.credential_fields,
  }));
}

/** 编辑凭据时，空字段表示保留；只覆盖本次真正填写的字段。 */
export function mergeImCredentials(
  previous: Record<string, string>,
  submitted: Record<string, string> | undefined,
): Record<string, string> {
  return {
    ...previous,
    ...Object.fromEntries(Object.entries(submitted ?? {}).filter(([, value]) => value.trim().length > 0)),
  };
}
