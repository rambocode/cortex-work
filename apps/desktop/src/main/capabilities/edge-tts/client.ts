import { randomUUID } from "node:crypto";
import WebSocket from "ws";
import { EDGE_TTS_TRUSTED_CLIENT_TOKEN, secMsGecToken } from "./drm";

const EDGE_TTS_URL = "wss://speech.platform.bing.com/consumer/speech/synthesize/readaloud/edge/v1";
const EDGE_ORIGIN = "chrome-extension://jdiccldimpdaibmpdkjnbmckianbfold";
const EDGE_USER_AGENT = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36 Edg/140.0.3485.14";
const CONNECT_TIMEOUT_MS = 60_000;

// 130.0.2849.68 已于 2026-08 实测被拒。微软会持续提升下限；所有候选均 403 时优先更新此表。
const SEC_MS_GEC_VERSIONS = ["1-140.0.3485.14", "1-139.0.3405.86", "1-138.0.3351.95"];
let workingVersionIndex = 0;

export interface EdgeTtsSynthesizeRequest {
  text: string;
  voice: string;
  rate?: number;
  pitch?: number;
  signal?: AbortSignal;
}

function escapeXml(value: string): string {
  return value.replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&apos;" })[char]!);
}

function prosodyRate(rate?: number): string {
  const percent = Math.round(((rate ?? 1) - 1) * 100);
  return `${percent >= 0 ? "+" : ""}${percent}%`;
}

function buildSsml({ text, voice, rate, pitch }: EdgeTtsSynthesizeRequest): string {
  const pitchHz = Math.round(pitch ?? 0);
  return `<speak version='1.0' xml:lang='zh-CN'><voice name='${escapeXml(voice)}'><prosody rate='${prosodyRate(rate)}' pitch='${pitchHz >= 0 ? "+" : ""}${pitchHz}Hz'>${escapeXml(text)}</prosody></voice></speak>`;
}

function binaryAudio(message: WebSocket.RawData): Uint8Array | null {
  const bytes = Buffer.isBuffer(message) ? message : Buffer.from(message as ArrayBuffer);
  if (bytes.length < 2) return null;
  const headerLength = bytes.readUInt16BE(0);
  return bytes.length > headerLength + 2 ? bytes.subarray(headerLength + 2) : null;
}

async function synthesizeWithVersion(request: EdgeTtsSynthesizeRequest, version: string): Promise<ArrayBuffer> {
  const connectionId = randomUUID().replaceAll("-", "");
  const query = new URLSearchParams({ TrustedClientToken: EDGE_TTS_TRUSTED_CLIENT_TOKEN, "Sec-MS-GEC": secMsGecToken(), "Sec-MS-GEC-Version": version, ConnectionId: connectionId });
  const socket = new WebSocket(`${EDGE_TTS_URL}?${query}`, { headers: { Origin: EDGE_ORIGIN, "User-Agent": EDGE_USER_AGENT } });
  const chunks: Buffer[] = [];
  return await new Promise<ArrayBuffer>((resolve, reject) => {
    let settled = false;
    const settle = (error?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      request.signal?.removeEventListener("abort", abort);
      socket.close();
      if (error) reject(error);
      else {
        const audio = Buffer.concat(chunks);
        resolve(audio.buffer.slice(audio.byteOffset, audio.byteOffset + audio.byteLength));
      }
    };
    const abort = () => settle(new DOMException("TTS synthesis aborted", "AbortError"));
    const timeout = setTimeout(() => settle(new Error("Edge TTS 合成超时")), CONNECT_TIMEOUT_MS);
    if (request.signal?.aborted) return abort();
    request.signal?.addEventListener("abort", abort, { once: true });
    socket.once("error", (error) => settle(error));
    socket.once("unexpected-response", (_req, response) => settle(new Error(`Edge TTS 握手 HTTP ${response.statusCode ?? 0}`)));
    socket.on("open", () => {
      socket.send("X-Timestamp:" + new Date().toISOString() + "\r\nContent-Type:application/json; charset=utf-8\r\nPath:speech.config\r\n\r\n{\"context\":{\"synthesis\":{\"audio\":{\"metadataoptions\":{\"sentenceBoundaryEnabled\":false,\"wordBoundaryEnabled\":false},\"outputFormat\":\"audio-24khz-48kbitrate-mono-mp3\"}}}}}");
      socket.send(`X-RequestId:${connectionId}\r\nContent-Type:application/ssml+xml\r\nX-Timestamp:${new Date().toISOString()}\r\nPath:ssml\r\n\r\n${buildSsml(request)}`);
    });
    socket.on("message", (message, isBinary) => {
      if (isBinary) {
        const audio = binaryAudio(message);
        if (audio?.length) chunks.push(Buffer.from(audio));
      } else if (message.toString().includes("Path:turn.end")) {
        if (chunks.length === 0) settle(new Error("Edge TTS 未返回音频"));
        else settle();
      }
    });
  });
}

/** 403 仅表示该 Chromium 版本已失效；其它失败不重试以免重复朗读请求。 */
export async function synthesizeEdgeTts(request: EdgeTtsSynthesizeRequest): Promise<ArrayBuffer> {
  let lastError: Error | null = null;
  for (let offset = 0; offset < SEC_MS_GEC_VERSIONS.length; offset += 1) {
    const index = (workingVersionIndex + offset) % SEC_MS_GEC_VERSIONS.length;
    try {
      const result = await synthesizeWithVersion(request, SEC_MS_GEC_VERSIONS[index]!);
      workingVersionIndex = index;
      return result;
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error));
      if (!lastError.message.includes("HTTP 403")) throw lastError;
    }
  }
  throw lastError ?? new Error("Edge TTS 连接失败");
}
