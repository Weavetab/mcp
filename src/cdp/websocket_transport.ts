import { WebSocketServer, WebSocket } from "ws";
import type { Transport, TransportSendOptions } from "@modelcontextprotocol/sdk/shared/transport.js";
import type { JSONRPCMessage } from "@modelcontextprotocol/sdk/types.js";
import * as crypto from "node:crypto";
import * as os from "node:os";
import * as path from "node:path";
import * as fs from "node:fs";

// WebSocket authentication: generate or load a shared secret for authentication
const WS_SECRET_FILE = path.join(os.homedir(), ".weavetab-system", "ws-secret");
let wsSecret: string;

export function getWebSocketSecret(): string {
  if (wsSecret) return wsSecret;
  
  try {
    if (fs.existsSync(WS_SECRET_FILE)) {
      wsSecret = fs.readFileSync(WS_SECRET_FILE, "utf-8").trim();
    } else {
      wsSecret = crypto.randomBytes(32).toString("hex");
      const dir = path.dirname(WS_SECRET_FILE);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(WS_SECRET_FILE, wsSecret, { mode: 0o600 });
    }
  } catch {
    wsSecret = crypto.randomBytes(32).toString("hex");
  }
  
  return wsSecret;
}

export class WebSocketServerTransport implements Transport {
  private wss: WebSocketServer;
  private activeSocket: WebSocket | null = null;
  private authenticated: boolean = false;
  
  onclose?: () => void;
  onerror?: (error: Error) => void;
  onmessage?: (message: JSONRPCMessage) => void;

  constructor(port: number) {
    this.wss = new WebSocketServer({ port, maxPayload: 1024 * 1024 }); // 1MB limit
    this.wss.on("connection", (ws) => {
      if (this.activeSocket) {
        ws.close(1013, "Only one concurrent connection allowed");
        return;
      }
      
      // Require authentication before accepting messages
      this.authenticated = false;
      
      ws.on("message", (data) => {
        try {
          const rawMessage = data.toString();
          const message = JSON.parse(rawMessage) as JSONRPCMessage;
          
          // Check for authentication handshake
          if (!this.authenticated) {
            const msg = message as any;
            if (msg.method === "authenticate" && msg.params && Array.isArray(msg.params)) {
              const providedSecret = msg.params[0] as string;
              const expectedSecret = getWebSocketSecret();
              
              if (providedSecret === expectedSecret) {
                this.authenticated = true;
                this.activeSocket = ws;
                ws.send(JSON.stringify({ result: { authenticated: true }, id: msg.id }));
                return;
              } else {
                ws.send(JSON.stringify({ error: { code: -32000, message: "Authentication failed" }, id: msg.id }));
                ws.close(1008, "Authentication failed");
                return;
              }
            } else {
              ws.send(JSON.stringify({ error: { code: -32001, message: "Authentication required" }, id: msg.id }));
              return;
            }
          }
          
          // Only process messages after authentication
          this.onmessage?.(message);
        } catch (err: any) {
          this.onerror?.(err);
        }
      });

      ws.on("error", (err) => {
        this.onerror?.(err);
      });

      ws.on("close", () => {
        this.activeSocket = null;
        this.authenticated = false;
        this.onclose?.();
      });
    });

    this.wss.on("error", (err) => {
      this.onerror?.(err);
    });
  }

  async start(): Promise<void> {
    // Already started listening on construction
  }

  async send(message: JSONRPCMessage, options?: TransportSendOptions): Promise<void> {
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
      this.wss.close(() => resolve());
    });
  }
}
