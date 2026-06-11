import { describe, it, expect } from "vitest";
import { getConversation } from "../mock/api";
import { applySendMessage, applyApproveDecision } from "./mutations";
import type { Conversation } from "../types";

async function wangyutong(): Promise<Conversation> {
  const c = await getConversation("wangyutong");
  if (!c) throw new Error("fixture missing");
  return c;
}

describe("applySendMessage", () => {
  it("appends my message and drops any standing typing indicator", async () => {
    const convo = await wangyutong();
    expect(convo.messages.some((m) => m.kind === "typing")).toBe(true);

    const next = applySendMessage(convo, "看起来不错,继续", "09:25");

    expect(next.messages.some((m) => m.kind === "typing")).toBe(false);
    const last = next.messages[next.messages.length - 1]!;
    expect(last.kind).toBe("text");
    if (last.kind === "text") {
      expect(last.who).toBe("me");
      expect(last.text).toBe("看起来不错,继续");
    }
  });
});

describe("applyApproveDecision", () => {
  it("marks the upstream diff card applied and turns the approve card into an active log", async () => {
    const convo = await wangyutong();
    const approve = convo.messages.find((m) => m.kind === "approve")!;

    const next = applyApproveDecision(convo, approve.uid!, "approve", "09:26");

    const diff = next.messages.find((m) => m.kind === "diff");
    expect(diff && diff.kind === "diff" && diff.status).toBe("applied");

    const converted = next.messages.find((m) => m.uid === approve.uid)!;
    expect(converted.kind).toBe("agentLog");
    if (converted.kind === "agentLog") {
      expect(converted.active).toBe(true);
      expect(converted.title).toContain("已批准");
    }
  });

  it("marks the diff rejected and resets the work tree on reject", async () => {
    const convo = await wangyutong();
    const approve = convo.messages.find((m) => m.kind === "approve")!;

    const next = applyApproveDecision(convo, approve.uid!, "reject", "09:26");

    const diff = next.messages.find((m) => m.kind === "diff");
    expect(diff && diff.kind === "diff" && diff.status).toBe("rejected");
    const converted = next.messages.find((m) => m.uid === approve.uid)!;
    expect(converted.kind).toBe("agentLog");
    if (converted.kind === "agentLog") {
      expect(converted.completed).toBe(true);
    }
  });
});
