// 所有子代理共用 Cortex 的正式水母 Logo，确保列表、详情、自定义角色和自动角色都保持
// 本项目品牌一致性。图片仅用于装饰，角色身份仍由相邻名称与状态文本表达。

import cortexLogo from "./assets/cortex-desktop-logo-minimal.png";

export function SubagentAvatar({
  disabled = false,
  size = 34,
}: {
  disabled?: boolean;
  size?: number;
}) {
  return (
    <span className={`pw-sa-brand-logo ${disabled ? "is-disabled" : ""}`} style={{ width: size, height: size }}>
      <img src={cortexLogo} alt="" aria-hidden="true" />
    </span>
  );
}
