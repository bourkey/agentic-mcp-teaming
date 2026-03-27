import { randomUUID } from "crypto";
import { readFile, writeFile, mkdir } from "fs/promises";
import { join } from "path";
import { ReviewSnapshot } from "../schema.js";

export class SnapshotStore {
  private readonly dir: string;

  constructor(sessionsDir: string, sessionId: string) {
    this.dir = join(sessionsDir, sessionId, "snapshots");
  }

  async capture(
    artifactId: string,
    artifactContent: string,
    round: number,
    toolOutputs: Record<string, string> = {}
  ): Promise<ReviewSnapshot> {
    const snapshot: ReviewSnapshot = {
      snapshotId: randomUUID(),
      artifactId,
      artifactContent,
      round,
      toolOutputs,
      capturedAt: new Date().toISOString(),
    };
    await mkdir(this.dir, { recursive: true });
    await writeFile(
      join(this.dir, `${snapshot.snapshotId}.json`),
      JSON.stringify(snapshot, null, 2),
      "utf8"
    );
    return snapshot;
  }

  async load(snapshotId: string): Promise<ReviewSnapshot> {
    const raw = await readFile(join(this.dir, `${snapshotId}.json`), "utf8");
    return ReviewSnapshot.parse(JSON.parse(raw) as unknown);
  }
}
