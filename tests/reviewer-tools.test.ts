import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("child_process", () => {
  const execFileMock = vi.fn();
  return { execFile: execFileMock };
});

import { execFile } from "child_process";
import { invokeReviewerTool } from "../src/server/tools/agents.js";
import type { ReviewerConfig } from "../src/config.js";

const mockExecFile = vi.mocked(execFile);

const cliReviewer: ReviewerConfig = {
  stage: ["spec", "code"],
  role: "peer",
  specialty: "Cross-cutting peer review",
  optional: true,
  cli: "codex",
};

function setupExecFileResult(stdout: string): void {
  mockExecFile.mockImplementation((_cmd, _args, _opts, cb) => {
    const callback = cb as (err: null, result: { stdout: string; stderr: string }) => void;
    callback(null, { stdout, stderr: "" });
    return {} as ReturnType<typeof execFile>;
  });
}

function setupExecFileError(err: Error): void {
  mockExecFile.mockImplementation((_cmd, _args, _opts, cb) => {
    const callback = cb as (err: Error) => void;
    callback(err);
    return {} as ReturnType<typeof execFile>;
  });
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("invokeReviewerTool", () => {
  it("returns parsed findings on successful CLI invocation", async () => {
    setupExecFileResult(
      JSON.stringify({
        findings: [
          {
            finding: "Missing auth check",
            severity: "critical",
            proposedFix: "Add auth middleware",
            location: "src/server/index.ts",
          },
        ],
      })
    );

    const result = await invokeReviewerTool({
      reviewerId: "test-peer",
      reviewer: cliReviewer,
      stage: "spec",
      artifactContent: "# Proposal",
      timeoutMs: 5000,
    });

    expect(result.reviewerId).toBe("test-peer");
    expect(result.findings).toHaveLength(1);
    expect(result.findings[0]!.finding).toBe("Missing auth check");
    expect(result.findings[0]!.severity).toBe("critical");
    expect(result.timedOut).toBeFalsy();
  });

  it("returns empty findings when CLI output is not valid JSON", async () => {
    setupExecFileResult("not json output at all");

    const result = await invokeReviewerTool({
      reviewerId: "test-peer",
      reviewer: cliReviewer,
      stage: "spec",
      artifactContent: "# Proposal",
      timeoutMs: 5000,
    });

    expect(result.reviewerId).toBe("test-peer");
    expect(result.findings).toEqual([]);
    expect(result.timedOut).toBeFalsy();
  });

  it("returns timedOut flag and empty findings when CLI times out", async () => {
    const timeoutErr = Object.assign(new Error("killed"), { killed: true });
    setupExecFileError(timeoutErr);

    const result = await invokeReviewerTool({
      reviewerId: "test-peer",
      reviewer: cliReviewer,
      stage: "code",
      artifactContent: "content",
      timeoutMs: 50,
    });

    expect(result.findings).toEqual([]);
    expect(result.timedOut).toBe(true);
  });

  it("throws when CLI binary is not found (ENOENT)", async () => {
    const enoentErr = Object.assign(new Error("spawn ENOENT"), { code: "ENOENT" });
    setupExecFileError(enoentErr);

    await expect(
      invokeReviewerTool({
        reviewerId: "required-reviewer",
        reviewer: { ...cliReviewer, optional: false },
        stage: "spec",
        artifactContent: "content",
        timeoutMs: 5000,
      })
    ).rejects.toThrow("spawn ENOENT");
  });

  it("returns empty findings array when reviewer JSON has empty findings", async () => {
    setupExecFileResult(JSON.stringify({ findings: [] }));

    const result = await invokeReviewerTool({
      reviewerId: "test-peer",
      reviewer: cliReviewer,
      stage: "code",
      artifactContent: "content",
      timeoutMs: 5000,
    });

    expect(result.findings).toEqual([]);
    expect(result.timedOut).toBeFalsy();
  });
});
