import { watch, readdirSync, statSync } from "fs";
import { join } from "path";
import type * as vscode from "vscode";
import type { ExtensionEventBus } from "../bus/ExtensionEventBus";

type FsWatcher = ReturnType<typeof watch>;

export class SessionWatcher {
  private watcher: FsWatcher | null = null;
  private activeSessionId: string | null = null;

  constructor(
    private readonly sessionsDir: string,
    private readonly bus: ExtensionEventBus,
  ) {}

  start(context: vscode.ExtensionContext): void {
    this.selectMostRecentSession();
    try {
      this.watcher = watch(this.sessionsDir, () => {
        const prev = this.activeSessionId;
        this.selectMostRecentSession();
        if (this.activeSessionId !== prev) {
          this.bus.publish({ type: "session_changed", sessionId: this.activeSessionId });
        }
      });
    } catch {
      // sessions dir may not exist yet — no error
    }
    context.subscriptions.push({ dispose: () => this.stop() });
  }

  stop(): void {
    this.watcher?.close();
    this.watcher = null;
  }

  getActiveSessionId(): string | null {
    return this.activeSessionId;
  }

  setActiveSession(sessionId: string): void {
    this.activeSessionId = sessionId;
    this.bus.publish({ type: "session_changed", sessionId });
  }

  listSessionIds(): string[] {
    try {
      return readdirSync(this.sessionsDir).filter((name) => {
        try {
          return statSync(join(this.sessionsDir, name)).isDirectory();
        } catch {
          return false;
        }
      });
    } catch {
      return [];
    }
  }

  private selectMostRecentSession(): void {
    const ids = this.listSessionIds();
    if (ids.length === 0) {
      this.activeSessionId = null;
      return;
    }
    let latest = ids[0]!;
    let latestMtime = 0;
    for (const id of ids) {
      try {
        const mtime = statSync(join(this.sessionsDir, id)).mtimeMs;
        if (mtime > latestMtime) {
          latestMtime = mtime;
          latest = id;
        }
      } catch {
        // ignore unreadable entries
      }
    }
    this.activeSessionId = latest;
  }
}
