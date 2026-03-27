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

  constructor(sessionsDir: string, sessionId: string) {
    this.logPath = join(sessionsDir, sessionId, "audit.log");
  }

  log(data: Omit<AuditEntry, "timestamp">): void {
    // eslint-disable-next-line @typescript-eslint/consistent-type-assertions
    const entry = { timestamp: new Date().toISOString(), ...data } as AuditEntry;
    this.append(entry).catch((err) => {
      console.error("AuditLogger write failed:", err);
    });
  }

  private async append(entry: AuditEntry): Promise<void> {
    if (!this.initialized) {
      await mkdir(join(this.logPath, ".."), { recursive: true });
      this.initialized = true;
    }
    await appendFile(this.logPath, JSON.stringify(entry) + "\n", "utf8");
  }
}
