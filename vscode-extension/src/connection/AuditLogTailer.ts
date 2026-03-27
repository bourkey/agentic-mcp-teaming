import { watch, openSync, readSync, statSync, closeSync } from "fs";
import { join } from "path";
import type { ExtensionEventBus } from "../bus/ExtensionEventBus";

type FsWatcher = ReturnType<typeof watch>;

export class AuditLogTailer {
  private watcher: FsWatcher | null = null;
  private byteOffset = 0;
  private currentPath: string | null = null;

  constructor(
    private readonly sessionsDir: string,
    private readonly bus: ExtensionEventBus,
    private readonly warnLog: (msg: string) => void = (msg) => console.warn(msg),
  ) {}

  tail(sessionId: string): void {
    this.stop();
    this.byteOffset = 0;
    this.currentPath = join(this.sessionsDir, sessionId, "audit.log");
    this.readNewLines();
    this.watchFile();
  }

  stop(): void {
    this.watcher?.close();
    this.watcher = null;
    this.currentPath = null;
    this.byteOffset = 0;
  }

  private watchFile(): void {
    if (!this.currentPath) return;
    try {
      this.watcher = watch(this.currentPath, () => this.readNewLines());
    } catch {
      // File doesn't exist yet — watch parent directory for creation
      const dir = join(this.currentPath, "..");
      try {
        const logFilename = "audit.log";
        const dirWatcher = watch(dir, (_event, filename) => {
          if (filename === logFilename && this.currentPath) {
            dirWatcher.close();
            this.readNewLines();
            this.watchFile();
          }
        });
        this.watcher = dirWatcher;
      } catch {
        // sessions dir not accessible
      }
    }
  }

  private readNewLines(): void {
    if (!this.currentPath) return;
    let size: number;
    try {
      size = statSync(this.currentPath).size;
    } catch {
      return;
    }
    if (size <= this.byteOffset) return;

    const fd = openSync(this.currentPath, "r");
    const buf = Buffer.alloc(size - this.byteOffset);
    const bytesRead = readSync(fd, buf, 0, buf.length, this.byteOffset);
    closeSync(fd);
    this.byteOffset += bytesRead;

    const text = buf.subarray(0, bytesRead).toString("utf8");
    const lines = text.split("\n").filter((l) => l.trim().length > 0);
    for (const line of lines) {
      this.processLine(line);
    }
  }

  private processLine(line: string): void {
    let entry: Record<string, unknown>;
    try {
      entry = JSON.parse(line) as Record<string, unknown>;
    } catch {
      this.warnLog(`[AuditLogTailer] malformed NDJSON: ${line.slice(0, 80)}`);
      return;
    }

    const type = entry["type"] as string | undefined;
    const ts = (entry["timestamp"] as string | undefined) ?? new Date().toISOString();

    switch (type) {
      case "agent_invocation": {
        const resp = entry["response"] as Record<string, unknown> | undefined;
        this.bus.publish({
          type: "agent_turn",
          sessionId: (entry["sessionId"] as string) ?? "",
          agentId: (entry["agentId"] as string) ?? "",
          phase: (entry["phase"] as string) ?? "",
          action: (resp?.["action"] as string) ?? "comment",
          artifactId: (entry["artifactId"] as string) ?? "",
          round: (entry["round"] as number) ?? 0,
          content: (resp?.["content"] as string) ?? "",
          timestamp: ts,
        });
        break;
      }
      case "phase_advance":
      case "phase_complete":
        this.bus.publish({
          type: "phase_changed",
          fromPhase: (entry["fromPhase"] as string) ?? "",
          toPhase: (entry["toPhase"] as string) ?? (entry["phase"] as string) ?? "",
          timestamp: ts,
        });
        break;
      case "consensus_end":
        this.bus.publish({
          type: "artifact_outcome",
          artifactId: (entry["artifactId"] as string) ?? "",
          outcome: (entry["outcome"] as string) ?? "pending",
          rounds: (entry["rounds"] as number) ?? 0,
          timestamp: ts,
        });
        break;
      case "checkpoint_presented":
        this.bus.publish({
          type: "checkpoint_triggered",
          artifactId: (entry["artifactId"] as string) ?? "",
          reason: (entry["reason"] as string) ?? "",
          sessionId: (entry["sessionId"] as string) ?? "",
          timestamp: ts,
        });
        break;
      case "checkpoint_resolved":
        this.bus.publish({
          type: "checkpoint_resolved",
          decision: ((entry["decision"] as string) === "abort" ? "abort" : "proceed"),
          artifactId: (entry["artifactId"] as string) ?? "",
          outcome: (entry["outcome"] as string) ?? "",
          timestamp: ts,
        });
        break;
      case "tool_call":
        this.bus.publish({
          type: "tool_call",
          tool: (entry["tool"] as string) ?? "",
          params: (entry["params"] as Record<string, unknown>) ?? {},
          sessionId: (entry["sessionId"] as string) ?? "",
          timestamp: ts,
        });
        break;
      default:
        break;
    }
  }
}
