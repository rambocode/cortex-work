/* eslint-disable i18next/no-literal-string -- 浏览器控制为桌面配置项,标签暂不本地化 */
import { useState } from "react";

import { usePersonalStore } from "@cortex-work/core";
import type { BrowserControlSettings } from "@cortex-work/core";

const EMPTY: BrowserControlSettings = { enabled: false, cdpEnabled: false, approvedOrigins: [] };

// 浏览器控制设置区(U8):总开关 + CDP「风险升高」确认开关 + 非本地导航预授权白名单。
// 由 SettingsMenu 的「应用 → 浏览器」分区（BrowserSection）渲染（原落 MCP sub-tab,已提升为
// 顶层分区）。读写 generalSettings.browserControl;主进程在 cli:start 按总开关注入浏览器
// MCP server(见 browser-mcp/inject)。views 不碰 Node。
export function BrowserControlSection() {
  const general = usePersonalStore((s) => s.generalSettings);
  const setBrowserControl = usePersonalStore((s) => s.setBrowserControl);
  const addApprovedOrigin = usePersonalStore((s) => s.addApprovedOrigin);
  const removeApprovedOrigin = usePersonalStore((s) => s.removeApprovedOrigin);
  const bc: BrowserControlSettings = general.browserControl ?? EMPTY;

  const [originInput, setOriginInput] = useState("");
  const [originError, setOriginError] = useState("");
  const [cdpConfirm, setCdpConfirm] = useState(false);

  // 仅接受 scheme 限定的 http(s) origin,归一为 origin(与 url-gate 白名单匹配口径一致)。
  const addOrigin = () => {
    let origin: string;
    try {
      const u = new URL(originInput.trim());
      if (u.protocol !== "http:" && u.protocol !== "https:") throw new Error("scheme");
      origin = u.origin;
    } catch {
      setOriginError("请输入完整 origin,如 https://example.com");
      return;
    }
    addApprovedOrigin(origin);
    setOriginInput("");
    setOriginError("");
  };

  return (
    <div className="pw-scard">
      <div className="pw-scard-t">浏览器控制(第一方)</div>

      <div className="pw-srow">
        <span className="pw-srow-lbl">允许 agent 控制内置浏览器</span>
        <label className="pw-srow-end">
          <input
            type="checkbox"
            aria-label="允许 agent 控制内置浏览器"
            checked={bc.enabled}
            onChange={(e) => setBrowserControl({ enabled: e.target.checked })}
          />
        </label>
      </div>
      <div className="pw-srow-desc">
        开启后 claude / codex 获得「浏览器控制」工具:在你正看的内置浏览器里导航 / 点击 / 填表 / 截图 / 读 DOM / 控制台。仅本地
        URL(localhost / 127.0.0.1)免审,非本地需在下方白名单预授权。若项目目录已有你自己的 .mcp.json,claude 不会被自动注入
        (需手动添加;codex 不受影响)。
      </div>

      {/* master 关时整组置灰但可见(fieldset disabled) */}
      <fieldset className="pw-bc-sub" disabled={!bc.enabled}>
        <div className="pw-srow">
          <span className="pw-srow-lbl pw-bc-risk">完整 CDP 访问(风险升高)</span>
          <label className="pw-srow-end">
            <input
              type="checkbox"
              aria-label="完整 CDP 访问"
              checked={bc.cdpEnabled}
              onChange={(e) => {
                if (e.target.checked) {
                  setCdpConfirm(true); // 启用前先确认
                } else {
                  setBrowserControl({ cdpEnabled: false });
                  setCdpConfirm(false);
                }
              }}
            />
          </label>
        </div>
        {cdpConfirm && !bc.cdpEnabled ? (
          <div className="pw-srow-desc pw-bc-risk">
            开启后 agent 可观测全部网络请求(含敏感头,展示时已脱敏)与无障碍树,并占用调试器(与开发者工具互斥)。确认启用?
            <button
              type="button"
              className="pw-btn"
              onClick={() => {
                setBrowserControl({ cdpEnabled: true });
                setCdpConfirm(false);
              }}
            >
              我已了解风险,启用
            </button>
          </div>
        ) : (
          <div className="pw-srow-desc">关闭时仅默认层工具(导航 / 点击 / 截图 / 读 DOM / 控制台)。</div>
        )}

        <div className="pw-srow-lbl pw-bc-listlbl">非本地导航预授权 origin</div>
        {bc.approvedOrigins.length === 0 ? (
          <div className="pw-scard-empty">尚无授权 origin。agent 请求非本地导航被拒时会提示该 origin,你在此添加后即放行。</div>
        ) : (
          <div className="pw-bc-list">
            {bc.approvedOrigins.map((o) => (
              <div key={o} className="pw-mcp-item">
                <span>{o}</span>
                <button type="button" className="pw-btn-sm" onClick={() => removeApprovedOrigin(o)}>
                  移除
                </button>
              </div>
            ))}
          </div>
        )}
        <div className="pw-bc-add">
          <input
            type="text"
            value={originInput}
            placeholder="https://example.com"
            aria-label="添加授权 origin"
            onChange={(e) => setOriginInput(e.target.value)}
          />
          <button type="button" className="pw-btn" onClick={addOrigin}>
            添加
          </button>
        </div>
        {originError ? <div className="pw-srow-desc pw-bc-risk">{originError}</div> : null}
      </fieldset>
    </div>
  );
}
