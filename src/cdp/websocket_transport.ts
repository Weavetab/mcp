import { WebSocketServer, WebSocket } from "ws";
import type { Transport, TransportSendOptions } from "@modelcontextprotocol/sdk/shared/transport.js";
import type { JSONRPCMessage } from "@modelcontextprotocol/sdk/types.js";
import * as crypto from "node:crypto";
import * as os from "node:os";
import * as path from "node:path";
import * as fs from "node:fs";
import { execFileSync } from "node:child_process";

const WS_SECRET_FILE = path.join(os.homedir(), ".weavetab-system", "ws-secret");
let wsSecret: string;

export function getOrCreateWsSecret(secretFilePath = WS_SECRET_FILE): string {
  if (secretFilePath === WS_SECRET_FILE && wsSecret) return wsSecret;

  if (fs.existsSync(secretFilePath)) {
    const raw = fs.readFileSync(secretFilePath, "utf-8").trim();
    if (!raw) {
      throw new Error(`ws-secret file is empty: ${secretFilePath}`);
    }
    if (secretFilePath === WS_SECRET_FILE) wsSecret = raw;
    return raw;
  }

  const generated = crypto.randomBytes(32).toString("hex");
  const dir = path.dirname(secretFilePath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  fs.writeFileSync(secretFilePath, generated, { mode: 0o600 });
  try {
    fs.chmodSync(secretFilePath, 0o600);
  } catch { /* non-fatal on some fs */ }

  if (process.platform === "win32") {
    const user = process.env.USERNAME || os.userInfo().username;
    if (user) {
      try {
        execFileSync("icacls", [secretFilePath, "/inheritance:r", "/grant:r", `${user}:(R,W)`], {
          stdio: "ignore",
          timeout: 3000,
        });
      } catch { /* non-fatal if icacls unavailable in restricted container */ }
    }
  }

  if (secretFilePath === WS_SECRET_FILE) wsSecret = generated;
  return generated;
}

export function getWebSocketSecret(): string {
  return getOrCreateWsSecret(WS_SECRET_FILE);
}

export function verifySecret(provided: string, expected: string): boolean {
  if (typeof provided !== "string" || !provided) return false;
  const a = Buffer.from(provided, "utf-8");
  const b = Buffer.from(expected, "utf-8");
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

export function isAllowedOrigin(origin: string | undefined): boolean {
  if (!origin) return true;
  try {
    const parsed = new URL(origin);
    return parsed.hostname === "127.0.0.1" || parsed.hostname === "localhost" || parsed.hostname === "[::1]";
  } catch {
    return false;
  }
}

export function isAllowedHost(host: string | undefined): boolean {
  if (!host) return false;
  try {
    const hostname = new URL("http://" + host).hostname.toLowerCase();
    return hostname === "127.0.0.1" || hostname === "localhost" || hostname === "[::1]";
  } catch {
    return false;
  }
}

export class WebSocketServerTransport implements Transport {
  private wss: WebSocketServer;
  private activeSocket: WebSocket | null = null;

  onclose?: () => void;
  onerror?: (error: Error) => void;
  onmessage?: (message: JSONRPCMessage) => void;

  constructor(port: number) {
    this.wss = new WebSocketServer({
      host: "127.0.0.1",
      port,
      maxPayload: 1024 * 1024,
      verifyClient: (info, cb) => {
        if (!isAllowedHost(info.req.headers.host)) {
          cb(false, 403, "Forbidden: DNS rebinding check failed");
          return;
        }
        if (!isAllowedOrigin(info.origin)) {
          cb(false, 403, "Forbidden: cross-origin WebSocket rejected");
          return;
        }
        cb(true);
      }
    });

    this.wss.on("connection", (ws, req) => {
      if (this.activeSocket && this.activeSocket.readyState === WebSocket.OPEN) {
        ws.close(1013, "Only one concurrent connection allowed");
        return;
      }

      let socketAuthed = false;
      let authTimer: ReturnType<typeof setTimeout> | null = null;

      const authHeader = req?.headers?.authorization;
      const bearerToken = authHeader?.startsWith("Bearer ") ? authHeader.slice(7).trim() : "";
      if (bearerToken && verifySecret(bearerToken, getWebSocketSecret())) {
        socketAuthed = true;
        this.activeSocket = ws;
      } else {
        authTimer = setTimeout(() => {
          if (!socketAuthed) {
            ws.close(1008, "Authentication timeout");
          }
        }, 5000);
        authTimer.unref();
      }

      ws.on("message", (data) => {
        try {
          const rawMessage = data.toString();
          const message = JSON.parse(rawMessage) as JSONRPCMessage;

          if (!socketAuthed) {
            const msg = message as any;
            if (msg.method === "authenticate" && msg.params && Array.isArray(msg.params)) {
              const providedSecret = msg.params[0] as string;
              const expectedSecret = getWebSocketSecret();

              if (verifySecret(providedSecret, expectedSecret)) {
                if (this.activeSocket && this.activeSocket !== ws && this.activeSocket.readyState === WebSocket.OPEN) {
                  ws.send(JSON.stringify({ error: { code: -32000, message: "Only one concurrent connection allowed" }, id: msg.id }));
                  ws.close(1013, "Only one concurrent connection allowed");
                  return;
                }
                if (authTimer) {
                  clearTimeout(authTimer);
                  authTimer = null;
                }
                socketAuthed = true;
                this.activeSocket = ws;
                ws.send(JSON.stringify({ result: { authenticated: true }, id: msg.id }));
                return;
              } else {
                if (authTimer) {
                  clearTimeout(authTimer);
                  authTimer = null;
                }
                ws.send(JSON.stringify({ error: { code: -32000, message: "Authentication failed" }, id: msg.id }));
                ws.close(1008, "Authentication failed");
                return;
              }
            } else {
              ws.send(JSON.stringify({ error: { code: -32001, message: "Authentication required" }, id: msg.id }));
              return;
            }
          }

          if (!socketAuthed || ws !== this.activeSocket) return;

          this.onmessage?.(message);
        } catch (err: any) {
          this.onerror?.(err);
        }
      });

      ws.on("error", (err) => {
        this.onerror?.(err);
      });

      ws.on("close", () => {
        if (authTimer) {
          clearTimeout(authTimer);
          authTimer = null;
        }
        if (ws === this.activeSocket) {
          this.activeSocket = null;
          this.onclose?.();
        }
      });
    });

    this.wss.on("error", (err) => {
      this.onerror?.(err);
    });
  }

  getPort(): number {
    const addr = this.wss.address();
    return typeof addr === "object" && addr ? addr.port : 0;
  }

  async start(): Promise<void> {}

  async send(message: JSONRPCMessage, _options?: TransportSendOptions): Promise<void> {
    if (!this.activeSocket) {
      throw new Error("No active WebSocket connection");
    }
    const socket = this.activeSocket;
    return new Promise((resolve, reject) => {
      socket.send(JSON.stringify(message), (err) => {
        if (err) reject(err);
        else resolve();
      });
    });
  }

  async close(): Promise<void> {
    if (this.activeSocket) {
      this.activeSocket.close();
      this.activeSocket = null;
    }
    return new Promise((resolve) => {
      for (const client of this.wss.clients) {
        try { client.terminate(); } catch {}
      }
      this.wss.close(() => resolve());
    });
  }
}
