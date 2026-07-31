import { appendFile, mkdir } from "fs/promises";
import { join } from "path";

export interface AuditEntry {
  timestamp: string;
  type: string;
  [key: string]: unknown;
}

export class AuditLogger {
  private readonly logPath: string;
  private initialized = false;
  private pendingWrite: Promise<void> = Promise.resolve();

  constructor(sessionsDir: string, sessionId: string) {
    this.logPath = join(sessionsDir, sessionId, "audit.log");
  }

  log(data: Omit<AuditEntry, "timestamp">): void {
    const entry = { timestamp: new Date().toISOString(), ...data } as AuditEntry;
    const write = this.pendingWrite.then(() => this.append(entry));
    this.pendingWrite = write.catch((err: unknown) => {
      console.error("AuditLogger write failed:", err);
    });
  }

  flush(): Promise<void> {
    return this.pendingWrite;
  }

  private async append(entry: AuditEntry): Promise<void> {
    if (!this.initialized) {
      await mkdir(join(this.logPath, ".."), { recursive: true });
      this.initialized = true;
    }
    await appendFile(this.logPath, JSON.stringify(entry) + "\n", "utf8");
  }
}
