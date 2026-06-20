import { describe, it, expect } from "vitest";
import {
  NTF_WIDTH,
  NTF_RIGHT_MARGIN,
  NTF_TOP_MARGIN,
  clampNotificationHeight,
  notificationWindowBounds,
} from "./notification-window-geometry";

describe("notification-window-geometry", () => {
  describe("clampNotificationHeight", () => {
    it("夹到 [1, workArea*0.85]", () => {
      expect(clampNotificationHeight(0, 1000)).toBe(1);
      expect(clampNotificationHeight(-50, 1000)).toBe(1);
      expect(clampNotificationHeight(300, 1000)).toBe(300);
      expect(clampNotificationHeight(9999, 1000)).toBe(850);
    });
    it("四舍五入小数高度", () => {
      expect(clampNotificationHeight(120.6, 1000)).toBe(121);
    });
  });

  describe("notificationWindowBounds", () => {
    it("右上角定位:右缘留白 + 顶边留白", () => {
      const wa = { x: 0, y: 0, width: 1440, height: 900 };
      const b = notificationWindowBounds(wa, 200);
      expect(b.width).toBe(NTF_WIDTH);
      expect(b.height).toBe(200);
      expect(b.x).toBe(1440 - NTF_WIDTH - NTF_RIGHT_MARGIN);
      expect(b.y).toBe(NTF_TOP_MARGIN);
    });
    it("尊重工作区原点偏移(多显示器/含菜单栏)", () => {
      const wa = { x: 1440, y: 25, width: 1920, height: 1055 };
      const b = notificationWindowBounds(wa, 150);
      expect(b.x).toBe(1440 + 1920 - NTF_WIDTH - NTF_RIGHT_MARGIN);
      expect(b.y).toBe(25 + NTF_TOP_MARGIN);
    });
  });
});
