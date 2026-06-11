import type { ReactNode } from "react";
import type { RichText } from "@cortex-work/core/types";

// Render a RichText value (string or typed parts) into inline JSX. Used by both
// the message stream (.m-text) and the agent log (.agent-log li).
export function renderRich(content: RichText | undefined): ReactNode {
  if (!content) return null;
  if (typeof content === "string") return content;
  return content.parts.map((p, i) => {
    switch (p.t) {
      case "text":
        return <span key={i}>{p.v}</span>;
      case "mention":
        return (
          <span key={i} className="mention">
            {p.v}
          </span>
        );
      case "code":
        return <code key={i}>{p.v}</code>;
      case "path":
        return (
          <span key={i} className="path">
            {p.v}
          </span>
        );
      default:
        return null;
    }
  });
}
