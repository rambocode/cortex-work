import { describe, expect, it, vi } from "vitest";

vi.mock("electron", () => ({
  BrowserWindow: vi.fn(),
  screen: { getPrimaryDisplay: () => ({ workArea: { x: 0, y: 0, width: 1440, height: 900 } }) },
}));
vi.mock("@electron-toolkit/utils", () => ({ is: { dev: false } }));

import {
  VOICE_CHAT_WINDOW_HEIGHT,
  VOICE_CHAT_WINDOW_WIDTH,
  voiceChatWindowBounds,
} from "./voice-chat-window";

describe("voiceChatWindowBounds", () => {
  it("在可用工作区居中放置固定尺寸的语音聊天窗", () => {
    expect(voiceChatWindowBounds({ x: 0, y: 0, width: 1440, height: 900 })).toEqual({
      x: (1440 - VOICE_CHAT_WINDOW_WIDTH) / 2,
      y: (900 - VOICE_CHAT_WINDOW_HEIGHT) / 2,
      width: VOICE_CHAT_WINDOW_WIDTH,
      height: VOICE_CHAT_WINDOW_HEIGHT,
    });
  });

  it("工作区小于窗口时钳在左上角，避免产生负坐标", () => {
    expect(voiceChatWindowBounds({ x: 100, y: 200, width: 200, height: 100 })).toEqual({
      x: 100,
      y: 200,
      width: VOICE_CHAT_WINDOW_WIDTH,
      height: VOICE_CHAT_WINDOW_HEIGHT,
    });
  });
});
