// 桌面宠物 overlay 窗口的位置持久化：~/.cortex-desktop/pet-position.json 全量读写。
// 仿 ipc/store.ts 的模式(内存镜像 + 串行化写入),但只存一个极简的 {x,y},不需要节流——
// 拖拽结束才写一次,不是逐帧写。

import { promises as fsp } from "fs";
import { dirname } from "path";
import { petPositionPath } from "../paths";
import { createLogger } from "../log";

const log = createLogger("pet-store");

interface PetPosition {
  x: number;
  y: number;
}

let cached: PetPosition | null | undefined; // undefined = 尚未从磁盘读过

export async function loadPetPosition(): Promise<PetPosition | null> {
  if (cached !== undefined) return cached;
  try {
    const raw = await fsp.readFile(petPositionPath(), "utf8");
    const parsed = JSON.parse(raw) as PetPosition;
    if (typeof parsed?.x === "number" && typeof parsed?.y === "number") {
      cached = parsed;
      return cached;
    }
  } catch {
    // 首次启动或文件损坏,回退 null(不缓存,等首次 save 建立镜像)。
  }
  cached = null;
  return null;
}

let writeQueue: Promise<void> = Promise.resolve();

export function savePetPosition(pos: PetPosition): void {
  cached = pos;
  const path = petPositionPath();
  writeQueue = writeQueue
    .then(async () => {
      await fsp.mkdir(dirname(path), { recursive: true });
      const tmp = `${path}.tmp`;
      await fsp.writeFile(tmp, JSON.stringify(pos), "utf8");
      await fsp.rename(tmp, path);
    })
    .catch((err) => {
      log.error("save failed:", err);
    });
}
