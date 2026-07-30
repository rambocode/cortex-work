// 成员头像：底色由姓名 hash 稳定派生（core memberAvatarColorIndex → pw-member-avatar--N 渐变类），
// 内容为姓名首字。不落盘、同名恒同色（参照 IFocus 资源管理头像）。
import { memberAvatarColorIndex } from "@cortex-work/core/personal/members";

export function MemberAvatar({ name, size = 32 }: { name: string; size?: number }) {
  const idx = memberAvatarColorIndex(name);
  return (
    <span
      className={`pw-member-avatar pw-member-avatar--${idx}`}
      style={{ width: size, height: size, fontSize: Math.round(size * 0.45) }}
      aria-hidden
    >
      {name.trim().charAt(0) || "?"}
    </span>
  );
}
