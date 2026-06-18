import { app } from "electron";

const SEMVER_RE = /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/;

export function getRuntimeAppVersion(): string {
  const devVersion = process.env.CORTEX_DEV_APP_VERSION?.trim();
  if (!app.isPackaged && devVersion && SEMVER_RE.test(devVersion)) return devVersion;
  return app.getVersion();
}
