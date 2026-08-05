import { randomUUID } from "node:crypto";
import WebSocket from "ws";
import { EDGE_TTS_TRUSTED_CLIENT_TOKEN, secMsGecToken } from "./drm";

const EDGE_TTS_URL = "wss://speech.platform.bing.com/consumer/speech/synthesize/readaloud/edge/v1";
const EDGE_ORIGIN = "chrome-extension://jdiccldimpdaibmpdkjnbmckianbfold";
const EDGE_USER_AGENT = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36 Edg/140.0.3485.14";
const CONNECT_TIMEOUT_MS = 60_000;
// 空闲即断：连接闲置着既占微软侧资源，也更容易在下次复用时撞上已被服务端静默回收的连接。
const IDLE_CLOSE_MS = 30_000;

// 130.0.2849.68 已于 2026-08 实测被拒。微软会持续提升下限；所有候选均 403 时优先更新此表。
const SEC_MS_GEC_VERSIONS = ["1-140.0.3485.14", "1-139.0.3405.86", "1-138.0.3351.95"];
let workingVersionIndex = 0;

// 用 JSON.stringify 生成而非手写转义字符串：手写版曾多敲一个右括号，服务端不校验细节、
// 直接以 close 1007「Bad request」断连且零音频，日志里看不出是报文问题，极难定位。
const SPEECH_CONFIG_PAYLOAD = JSON.stringify({
  context: {
    synthesis: {
      audio: {
        metadataoptions: { sentenceBoundaryEnabled: false, wordBoundaryEnabled: false },
        outputFormat: "audio-24khz-48kbitrate-mono-mp3",
      },
    },
  },
});

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

// ── 共享连接 ─────────────────────────────────────────────────────────────
// 实测单次合成 654~1456ms 里握手占了约八成，真正的合成只有 100~350ms。朗读按 30 字分块，
// 每块都重新握手的话首包与块间衔接都会被握手成本支配，因此整个主进程共用一条连接。
//
// 同一条连接上的请求严格串行（见 enqueue）：服务端本就按 X-RequestId 顺序处理，串行化后
// 帧路由不必按 id 分发，也不会出现两个请求的音频帧交错。
// 只有干净收到 turn.end 的请求才留下连接复用；中止 / 超时 / 报错一律作废整条连接——
// 我们没有办法让服务端停止一个已发出的请求，残留帧会被后一个请求误当成自己的内容。

interface InflightRequest {
  push(audio: Uint8Array): void;
  finish(): void;
  fail(error: Error): void;
}

interface SharedConnection {
  socket: WebSocket;
  idleTimer: ReturnType<typeof setTimeout> | null;
  inflight: InflightRequest | null;
}

let shared: SharedConnection | null = null;

/** 作废连接并让在途请求失败。之后的调用会重新握手。 */
function invalidate(connection: SharedConnection, error: Error): void {
  if (shared === connection) shared = null;
  if (connection.idleTimer) clearTimeout(connection.idleTimer);
  connection.idleTimer = null;
  const inflight = connection.inflight;
  connection.inflight = null;
  inflight?.fail(error);
  // error 监听始终在位，因此这里 close() 不会把异步 error 事件升级成未捕获异常。
  if (connection.socket.readyState !== WebSocket.CLOSED) connection.socket.close();
}

function scheduleIdleClose(connection: SharedConnection): void {
  if (connection.idleTimer) clearTimeout(connection.idleTimer);
  connection.idleTimer = setTimeout(() => invalidate(connection, new Error("Edge TTS 连接空闲关闭")), IDLE_CLOSE_MS);
  connection.idleTimer.unref?.();
}

async function openConnection(version: string): Promise<SharedConnection> {
  const query = new URLSearchParams({ TrustedClientToken: EDGE_TTS_TRUSTED_CLIENT_TOKEN, "Sec-MS-GEC": secMsGecToken(), "Sec-MS-GEC-Version": version, ConnectionId: randomUUID().replaceAll("-", "") });
  const socket = new WebSocket(`${EDGE_TTS_URL}?${query}`, { headers: { Origin: EDGE_ORIGIN, "User-Agent": EDGE_USER_AGENT } });
  const connection: SharedConnection = { socket, idleTimer: null, inflight: null };

  return await new Promise<SharedConnection>((resolve, reject) => {
    let settled = false;
    const timeout = setTimeout(() => {
      if (settled) return;
      settled = true;
      reject(new Error("Edge TTS 连接超时"));
      socket.close();
    }, CONNECT_TIMEOUT_MS);
    // 握手期失败与建连后掉线共用一套出口：settled 之前算建连失败，之后算连接作废。
    const abandon = (error: Error) => {
      clearTimeout(timeout);
      if (settled) invalidate(connection, error);
      else {
        settled = true;
        reject(error);
        if (socket.readyState !== WebSocket.CLOSED) socket.close();
      }
    };

    // 这三个监听必须先于任何 close() 注册：ws 对「握手中被关闭」抛的是异步 error 事件，
    // 没有监听者时 EventEmitter 会把它升级成未捕获异常，直接掀掉主进程。
    socket.on("error", (error) => abandon(error));
    socket.on("unexpected-response", (_req, response) => abandon(new Error(`Edge TTS 握手 HTTP ${response.statusCode ?? 0}`)));
    // 服务端主动断连（报文不合法 1007、限流、回收空闲连接）只触发 close，不触发 error。
    socket.on("close", (code, reason) => abandon(new Error(`Edge TTS 连接关闭 ${code}${reason.length ? `：${reason.toString()}` : ""}`)));
    socket.on("message", (message, isBinary) => {
      const inflight = connection.inflight;
      if (!inflight) return; // 作废请求的残留帧：直接丢弃，不能算进下一个请求
      if (isBinary) {
        const audio = binaryAudio(message);
        if (audio?.length) inflight.push(audio);
      } else if (message.toString().includes("Path:turn.end")) {
        inflight.finish();
      }
    });
    socket.on("open", () => {
      clearTimeout(timeout);
      settled = true;
      socket.send(`X-Timestamp:${new Date().toISOString()}\r\nContent-Type:application/json; charset=utf-8\r\nPath:speech.config\r\n\r\n${SPEECH_CONFIG_PAYLOAD}`);
      resolve(connection);
    });
  });
}

function synthesizeOn(connection: SharedConnection, request: EdgeTtsSynthesizeRequest): Promise<ArrayBuffer> {
  return new Promise<ArrayBuffer>((resolve, reject) => {
    const chunks: Uint8Array[] = [];
    let settled = false;
    const stop = () => {
      settled = true;
      clearTimeout(timeout);
      request.signal?.removeEventListener("abort", abort);
    };
    const fail = (error: Error) => {
      if (settled) return;
      stop();
      reject(error);
    };
    // 中止与超时都要连坐整条连接：服务端仍会把这次请求的剩余音频推过来。
    const abort = () => {
      if (settled) return;
      stop();
      invalidate(connection, new DOMException("TTS synthesis aborted", "AbortError"));
      reject(new DOMException("TTS synthesis aborted", "AbortError"));
    };
    const timeout = setTimeout(() => {
      if (settled) return;
      stop();
      invalidate(connection, new Error("Edge TTS 合成超时"));
      reject(new Error("Edge TTS 合成超时"));
    }, CONNECT_TIMEOUT_MS);

    connection.inflight = {
      push: (audio) => chunks.push(audio),
      finish: () => {
        if (settled) return;
        stop();
        connection.inflight = null;
        if (chunks.length === 0) {
          // 服务端认了请求却没给音频（音色不存在等），连接本身仍可用。
          scheduleIdleClose(connection);
          reject(new Error("Edge TTS 未返回音频"));
          return;
        }
        const audio = Buffer.concat(chunks);
        scheduleIdleClose(connection);
        resolve(audio.buffer.slice(audio.byteOffset, audio.byteOffset + audio.byteLength));
      },
      fail,
    };

    if (request.signal?.aborted) return abort();
    request.signal?.addEventListener("abort", abort, { once: true });

    if (connection.idleTimer) clearTimeout(connection.idleTimer);
    connection.idleTimer = null;
    connection.socket.send(`X-RequestId:${randomUUID().replaceAll("-", "")}\r\nContent-Type:application/ssml+xml\r\nX-Timestamp:${new Date().toISOString()}\r\nPath:ssml\r\n\r\n${buildSsml(request)}`);
  });
}

async function synthesizeOnce(request: EdgeTtsSynthesizeRequest): Promise<ArrayBuffer> {
  // 排队期间用户可能已经按了停止：此时不该再去握手，也不该连累已建好的共享连接。
  if (request.signal?.aborted) throw new DOMException("TTS synthesis aborted", "AbortError");
  // 先用现成连接。复用失败最常见的原因是服务端已经悄悄回收了它——这种情况不该报给用户，
  // 重新握手再试一次即可；真正的错误（403、音色不存在）会在新连接上如实复现。
  if (shared && shared.socket.readyState === WebSocket.OPEN) {
    const reused = shared;
    try {
      return await synthesizeOn(reused, request);
    } catch (error) {
      if (request.signal?.aborted) throw error;
      if (error instanceof Error && error.message === "Edge TTS 未返回音频") throw error;
    }
  }

  let lastError: Error | null = null;
  for (let offset = 0; offset < SEC_MS_GEC_VERSIONS.length; offset += 1) {
    const index = (workingVersionIndex + offset) % SEC_MS_GEC_VERSIONS.length;
    let connection: SharedConnection;
    try {
      connection = await openConnection(SEC_MS_GEC_VERSIONS[index]!);
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error));
      // 403 只说明该 Chromium 版本已失效，换下一个候选；其它握手失败不重试。
      if (!lastError.message.includes("HTTP 403")) throw lastError;
      continue;
    }
    workingVersionIndex = index;
    shared = connection;
    return await synthesizeOn(connection, request);
  }
  throw lastError ?? new Error("Edge TTS 连接失败");
}

// 串行闸门：共享连接同一时刻只跑一个请求（播放层会预取下一块，天然存在并发调用）。
let queue: Promise<unknown> = Promise.resolve();

/** 合成一段文本，返回完整 mp3 字节。 */
export async function synthesizeEdgeTts(request: EdgeTtsSynthesizeRequest): Promise<ArrayBuffer> {
  const run = queue.then(() => synthesizeOnce(request));
  queue = run.catch(() => {}); // 前一个请求失败不能卡住后续朗读
  return await run;
}
