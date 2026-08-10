// 所有子代理共用 Cortex 的正式水母 Logo，确保列表、详情、自定义角色和自动角色都保持
// 本项目品牌一致性。图片仅用于装饰，角色身份仍由相邻名称与状态文本表达。

import cortexLogo from "./assets/cortex-desktop-logo-minimal.png";

// Vite 把静态图片声明为 URL string，Next.js 则声明为 StaticImageData。views 同时被 Desktop/Web
// 消费，故在共享边界收敛为浏览器可用的 URL，避免任一宿主的声明覆盖另一端后 typecheck 失败。
const cortexLogoSrc = typeof cortexLogo === "string"
  ? cortexLogo
  : (cortexLogo as { src: string }).src;

export function SubagentAvatar({
  disabled = false,
  size = 34,
}: {
  disabled?: boolean;
  size?: number;
}) {
  return (
    <span className={`pw-sa-brand-logo ${disabled ? "is-disabled" : ""}`} style={{ width: size, height: size }}>
      <img src={cortexLogoSrc} alt="" aria-hidden="true" />
    </span>
  );
}
