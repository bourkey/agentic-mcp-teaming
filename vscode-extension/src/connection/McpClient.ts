import * as http from "http";
import type { ExtensionEventBus } from "../bus/ExtensionEventBus";

export class McpClient {
  private sessionId: string | null = null;
  private sseReq: http.ClientRequest | null = null;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private disposed = false;
  private retryDelay = 1000;
  private readonly maxRetryDelay = 30_000;

  constructor(
    private readonly host: string,
    private readonly port: number,
    private readonly bus: ExtensionEventBus,
    private readonly authToken?: string,
  ) {}

  connect(): void {
    this.bus.publish({ type: "connection_state", state: "connecting" });
    this.doConnect();
  }

  private doConnect(): void {
    if (this.disposed) return;
    const req = http.get({
      host: this.host,
      port: this.port,
      path: "/sse",
      headers: this.authToken ? { Authorization: `Bearer ${this.authToken}` } : undefined,
    }, (res) => {
      if (res.statusCode !== undefined && res.statusCode >= 400) {
        this.scheduleReconnect("connecting");
        return;
      }
      this.retryDelay = 1000;
      let buffer = "";
      let currentEvent = "message";
      res.on("data", (chunk: Buffer) => {
        buffer += chunk.toString();
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";
        for (const line of lines) {
          if (line.startsWith("event: ")) {
            currentEvent = line.slice(7).trim();
            continue;
          }
          if (line.startsWith("data: ")) {
            const data = line.slice(6).trim();
            if (currentEvent === "endpoint") {
              try {
                const endpointUrl = new URL(data, `http://${this.host}:${this.port}`);
                const sessionId = endpointUrl.searchParams.get("sessionId");
                if (sessionId && !this.sessionId) {
                  this.sessionId = sessionId;
                  this.bus.publish({ type: "connection_state", state: "connected" });
                }
              } catch {
                // malformed endpoint event
              }
            } else {
              try {
                const parsed = JSON.parse(data) as { sessionId?: string };
                if (parsed.sessionId && !this.sessionId) {
                  this.sessionId = parsed.sessionId;
                  this.bus.publish({ type: "connection_state", state: "connected" });
                }
              } catch {
                // non-JSON SSE data
              }
            }
          }
          if (line.trim() === "") currentEvent = "message";
        }
      });
      res.on("end", () => {
        if (!this.disposed) this.scheduleReconnect("reconnecting");
      });
      res.on("error", () => {
        if (!this.disposed) this.scheduleReconnect("reconnecting");
      });
    });
    req.on("error", () => {
      if (!this.disposed) this.scheduleReconnect("connecting");
    });
    this.sseReq = req;
  }

  private scheduleReconnect(state: "connecting" | "reconnecting"): void {
    this.sessionId = null;
    this.bus.publish({ type: "connection_state", state });
    this.retryTimer = setTimeout(() => {
      this.retryDelay = Math.min(this.retryDelay * 2, this.maxRetryDelay);
      this.doConnect();
    }, this.retryDelay);
  }

  async callTool(name: string, params: Record<string, unknown>): Promise<unknown> {
    return new Promise((resolve, reject) => {
      const body = JSON.stringify({
        jsonrpc: "2.0",
        method: "tools/call",
        params: { name, arguments: params },
        id: Date.now(),
      });
      const sid = this.sessionId;
      const path = sid ? `/message?sessionId=${encodeURIComponent(sid)}` : "/message";
      const req = http.request(
        {
          host: this.host,
          port: this.port,
          path,
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "Content-Length": Buffer.byteLength(body),
            ...(this.authToken ? { Authorization: `Bearer ${this.authToken}` } : {}),
          },
        },
        (res) => {
          let data = "";
          res.on("data", (chunk: Buffer) => { data += chunk.toString(); });
          res.on("end", () => {
            if (res.statusCode !== undefined && res.statusCode >= 200 && res.statusCode < 300) {
              try { resolve(JSON.parse(data)); } catch { resolve(data); }
            } else {
              reject(new Error(`HTTP ${res.statusCode ?? "?"}: ${data}`));
            }
          });
        },
      );
      req.on("error", reject);
      req.write(body);
      req.end();
    });
  }

  getSessionId(): string | null {
    return this.sessionId;
  }

  dispose(): void {
    this.disposed = true;
    if (this.retryTimer !== null) clearTimeout(this.retryTimer);
    this.sseReq?.destroy();
  }
}
