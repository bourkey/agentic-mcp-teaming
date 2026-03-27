import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm } from "fs/promises";
import { join } from "path";
import { tmpdir } from "os";
import { SessionManager } from "../src/core/session.js";

let tmpDir: string;

beforeEach(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), "session-test-"));
});

afterEach(async () => {
  await rm(tmpDir, { recursive: true, force: true });
});

describe("SessionManager.create", () => {
  it("creates a session with initial state", async () => {
    const sm = await SessionManager.create(tmpDir);
    const state = sm.get();
    expect(state.currentPhase).toBe("proposal");
    expect(state.sessionId).toBeTruthy();
    expect(state.checkpointPending).toBe(false);
  });

  it("uses provided sessionId", async () => {
    const sm = await SessionManager.create(tmpDir, "my-session");
    expect(sm.get().sessionId).toBe("my-session");
  });
});

describe("SessionManager.load", () => {
  it("loads existing session state", async () => {
    const sm = await SessionManager.create(tmpDir, "test-load");
    await sm.setPhase("design");
    const loaded = await SessionManager.load(tmpDir, "test-load");
    expect(loaded.get().currentPhase).toBe("design");
  });
});

describe("setPhase", () => {
  it("updates currentPhase and persists", async () => {
    const sm = await SessionManager.create(tmpDir);
    await sm.setPhase("spec");
    expect(sm.get().currentPhase).toBe("spec");
    const loaded = await SessionManager.load(tmpDir, sm.get().sessionId);
    expect(loaded.get().currentPhase).toBe("spec");
  });
});

describe("setArtifactOutcome", () => {
  it("sets and persists artifact outcome", async () => {
    const sm = await SessionManager.create(tmpDir);
    await sm.setArtifactOutcome("proposal-v1", "consensus-reached");
    expect(sm.get().artifactOutcomes["proposal-v1"]).toBe("consensus-reached");
    const loaded = await SessionManager.load(tmpDir, sm.get().sessionId);
    expect(loaded.get().artifactOutcomes["proposal-v1"]).toBe("consensus-reached");
  });
});

describe("incrementRevisionRound", () => {
  it("starts at 0 and increments", async () => {
    const sm = await SessionManager.create(tmpDir);
    expect(await sm.incrementRevisionRound("design-v1")).toBe(1);
    expect(await sm.incrementRevisionRound("design-v1")).toBe(2);
    expect(sm.get().revisionRounds["design-v1"]).toBe(2);
  });
});
