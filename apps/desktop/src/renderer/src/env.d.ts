/// <reference types="vite/client" />

import type { DesktopAPI } from "../../preload";

declare global {
  interface Window {
    desktopAPI?: DesktopAPI;
  }
}

export {};
