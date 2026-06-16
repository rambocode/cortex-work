// 站点页脚（server 组件，无客户端依赖）。
// 结构：顶部 divider → 主体（左品牌区 / 右多列链接）→ 底部（版权 / 语言开关）。
// 文案全部来自 d（Dict），不硬编码任何可见文字。

import { BrandMark } from "@/components/brand";
import { IconCheck } from "@/components/icons";
import { LangSwitch } from "@/components/ui";
import type { Dict } from "@/lib/dictionary";
import type { Locale } from "@/lib/i18n";

// 判定外链：以 http(s) 开头视为站外，需新窗口打开并加 rel 安全属性。
function isExternal(href: string): boolean {
  return /^https?:\/\//i.test(href);
}

export default function Footer({ d, locale }: { d: Dict; locale: Locale }) {
  return (
    <footer>
      <hr className="divider" />

      <div className="container section-sm">
        {/* 主体：左品牌叙事，右多列链接。窄屏自动堆叠为单列。 */}
        <div className="ftr-body">
          {/* 左：品牌标 + 一句话定位 + 本地优先承诺 */}
          <div className="ftr-brand">
            <BrandMark />
            <p className="muted ftr-tagline" style={{ textWrap: "balance" }}>
              {d.footer.tagline}
            </p>
            <p className="ftr-local muted">
              <IconCheck className="ftr-local-icon" />
              <span>{d.footer.localFirst}</span>
            </p>
          </div>

          {/* 右：链接分组，每组一列（标题 + 链接） */}
          <nav className="ftr-groups" aria-label={d.a11y.footerNav}>
            {d.footer.groups.map((group) => (
              <div className="ftr-group" key={group.title}>
                <h3 className="ftr-group-title">{group.title}</h3>
                <ul className="ftr-links">
                  {group.links.map((link) => {
                    const external = isExternal(link.href);
                    return (
                      <li key={link.href}>
                        <a
                          className="ftr-link"
                          href={link.href}
                          {...(external
                            ? { target: "_blank", rel: "noreferrer noopener" }
                            : {})}
                        >
                          {link.label}
                        </a>
                      </li>
                    );
                  })}
                </ul>
              </div>
            ))}
          </nav>
        </div>

        {/* 底部：版权（左） + 语言开关（右） */}
        <div className="ftr-bottom">
          <p className="muted ftr-copyright">{d.footer.copyright}</p>
          <LangSwitch locale={locale} />
        </div>
      </div>

      {/* 页脚 scoped 样式：仅靠既有 token，克制留白，移动端折叠。 */}
      <style>{`
        .ftr-body {
          display: grid;
          grid-template-columns: minmax(0, 1.3fr) minmax(0, 1fr);
          gap: clamp(32px, 5vw, 72px);
          align-items: start;
        }
        .ftr-brand {
          display: flex;
          flex-direction: column;
          gap: 16px;
          max-width: 38ch;
        }
        .ftr-tagline {
          font-size: var(--fs-lead);
          line-height: 1.5;
        }
        .ftr-local {
          display: flex;
          align-items: flex-start;
          gap: 9px;
          font-size: var(--fs-sm);
          line-height: 1.5;
          margin-top: 2px;
        }
        .ftr-local-icon {
          flex: none;
          width: 17px;
          height: 17px;
          margin-top: 2px;
          /* 荧光勾：智能氛围色，点到为止 */
          color: var(--glow-blue);
        }

        .ftr-groups {
          display: grid;
          grid-template-columns: repeat(auto-fit, minmax(120px, 1fr));
          gap: clamp(24px, 3vw, 44px);
        }
        .ftr-group-title {
          font-size: var(--fs-eyebrow);
          font-weight: 600;
          letter-spacing: 0.12em;
          text-transform: uppercase;
          color: var(--ink-3);
          margin-bottom: 14px;
        }
        .ftr-links {
          list-style: none;
          margin: 0;
          padding: 0;
          display: flex;
          flex-direction: column;
          gap: 11px;
        }
        .ftr-link {
          color: var(--ink-2);
          font-size: var(--fs-sm);
          transition: color 0.2s var(--ease);
        }
        .ftr-link:hover {
          color: var(--clay-deep);
        }

        .ftr-bottom {
          display: flex;
          align-items: center;
          justify-content: space-between;
          gap: 16px;
          flex-wrap: wrap;
          margin-top: clamp(36px, 5vw, 56px);
          padding-top: clamp(20px, 2.4vw, 28px);
          border-top: 1px solid var(--line);
        }
        .ftr-copyright {
          font-size: var(--fs-sm);
        }

        @media (max-width: 760px) {
          .ftr-body {
            grid-template-columns: 1fr;
            gap: 40px;
          }
        }
      `}</style>
    </footer>
  );
}
