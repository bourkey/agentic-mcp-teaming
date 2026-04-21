import * as fs from "fs";
import * as readline from "readline";
import type { Logger } from "./logger.js";

export const PEER_BUS_MAX_BODY_BYTES = 65536;
export const PEER_BUS_MAX_RESPONSE_BYTES = 1048576;

export type PeerMessageKind = "workflow-event" | "chat" | "request" | "response";

export interface PeerMessage {
  messageId: string;
  from: string;
  to: string;
  kind: PeerMessageKind;
  body: unknown;
  replyTo?: string;
  timestamp: string;
}

export function nowUtcIso(): string {
  return new Date().toISOString();
}

export function computeBodyByteLength(body: unknown): number {
  const serialised = typeof body === "string" ? body : JSON.stringify(body);
  return Buffer.byteLength(serialised, "utf8");
}

export class MessageStore {
  private readonly path: string;
  private readonly logger: Logger;
  private fd: number | null = null;

  constructor(path: string, logger: Logger) {
    this.path = path;
    this.logger = logger;
  }

  getPath(): string {
    return this.path;
  }

  async append(envelope: PeerMessage): Promise<void> {
    if (this.fd === null) {
      this.fd = fs.openSync(this.path, "a");
    }
    const line = JSON.stringify(envelope) + "\n";
    fs.writeSync(this.fd, line);
    fs.fsyncSync(this.fd);
  }

  async loadAll(): Promise<Map<string, PeerMessage>> {
    const result = new Map<string, PeerMessage>();
    if (!fs.existsSync(this.path)) return result;

    const input = fs.createReadStream(this.path, { encoding: "utf8" });
    const rl = readline.createInterface({ input, crlfDelay: Infinity });

    let lineNumber = 0;
    let byteOffset = 0;

    for await (const line of rl) {
      lineNumber += 1;
      const lineLength = Buffer.byteLength(line, "utf8") + 1; // +1 for newline
      const startOffset = byteOffset;
      byteOffset += lineLength;
      if (line.length === 0) continue;
      try {
        const parsed = JSON.parse(line) as PeerMessage;
        if (parsed && typeof parsed === "object" && typeof parsed.messageId === "string") {
          result.set(parsed.messageId, parsed);
        }
      } catch (err) {
        const preview = JSON.stringify(line.slice(0, 120));
        this.logger.warn("message-store: corrupt JSONL line skipped", {
          lineNumber,
          byteOffset: startOffset,
          lineLength: lineLength - 1,
          preview,
          error: (err as Error).message,
        });
      }
    }

    return result;
  }

  close(): void {
    if (this.fd !== null) {
      fs.closeSync(this.fd);
      this.fd = null;
    }
  }
}
