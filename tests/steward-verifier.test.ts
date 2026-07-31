import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { chmod, mkdtemp, rm, writeFile } from "fs/promises";
import { execFile } from "child_process";
import { promisify } from "util";
import { join } from "path";
import { tmpdir } from "os";
import { StewardVerifier } from "../src/core/steward-verifier.js";
import type { StewardIntegrationConfig } from "../src/config.js";

const execFileAsync = promisify(execFile);
let root: string;
let repo: string;
let commit: string;
let tree: string;
const approved = "a".repeat(40);

async function executable(name: string, body: string): Promise<string> {
  const path = join(root, name);
  await writeFile(path, `#!/bin/sh\n${body}\n`, "utf8");
  await chmod(path, 0o755);
  return path;
}

async function config(result: object, authorize = true): Promise<StewardIntegrationConfig> {
  const provider = await executable(
    `provider-${Math.random()}`,
    `printf '%s\\n' '${JSON.stringify(result)}'`
  );
  const iface = await executable(
    `interface-${Math.random()}`,
    `cat >/dev/null\nexit ${authorize ? 0 : 2}`
  );
  return {
    interfaceCommand: iface,
    providerCommand: provider,
    interfaceSchemaVersion: 1,
    resultSchemaVersion: 1,
    approvedDeclarationEnvVar: "TEST_APPROVED_DIGEST",
    timeoutMs: 2000,
    providerTimeoutMs: 2000,
  };
}

function result(overrides: Record<string, unknown> = {}) {
  return {
    verdict: "pass",
    reason: "executed",
    evidence: {
      repo: "local:test",
      commit,
      tree,
      provider: "container",
      declaration: {
        source: "steward-verify.json",
        digest: approved,
        approved_digest: approved,
      },
      attestation: { tier: "container-hard" },
    },
    commands: [{
      command: "true",
      exit: 0,
      outcome: "ok",
      duration_seconds: 1,
      output: { stdout_bytes: 0, stderr_bytes: 0, truncated: false },
    }],
    authenticator: { alg: "HMAC-SHA256", key_id: "test", value: "signed" },
    ...overrides,
  };
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "steward-verifier-test-"));
  repo = join(root, "repo");
  await execFileAsync("mkdir", ["-p", repo]);
  await execFileAsync("git", ["init", "-q"], { cwd: repo });
  await writeFile(join(repo, "file.txt"), "test\n");
  await execFileAsync("git", ["add", "file.txt"], { cwd: repo });
  await execFileAsync("git", ["-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "-qm", "test"], { cwd: repo });
  ({ stdout: commit } = await execFileAsync("git", ["rev-parse", "HEAD"], { cwd: repo }));
  ({ stdout: tree } = await execFileAsync("git", ["rev-parse", "HEAD^{tree}"], { cwd: repo }));
  commit = commit.trim();
  tree = tree.trim();
});

afterEach(async () => {
  delete process.env["TEST_APPROVED_DIGEST"];
  await rm(root, { recursive: true, force: true });
});

describe("StewardVerifier", () => {
  it("accepts only a result authorized and bound to exact immutable inputs", async () => {
    const verifier = new StewardVerifier(await config(result()), approved);
    const evidence = await verifier.verifyImplementation(repo, commit);
    expect(evidence.gateVerdict).toBe("pass");
    expect(evidence.candidateTree).toBe(tree);
    expect(evidence.gateResultDigest).toMatch(/^[0-9a-f]{64}$/);
    expect(evidence.commandOutcomes[0]?.commandDigest).toMatch(/^[0-9a-f]{64}$/);
    expect(evidence.commandOutcomes[0]?.outcome).toBe("ok");
  });

  it("rejects stale tree evidence", async () => {
    const stale = result();
    (stale.evidence as typeof stale.evidence).tree = "b".repeat(40);
    const verifier = new StewardVerifier(await config(stale), approved);
    await expect(verifier.verifyImplementation(repo, commit)).rejects.toThrow("stale");
  });

  it("rejects a result that Steward transition authorization blocks", async () => {
    const verifier = new StewardVerifier(await config(result(), false), approved);
    await expect(verifier.verifyImplementation(repo, commit)).rejects.toThrow("authorization blocked");
  });

  it("rejects absent trusted-driver approval", async () => {
    const cfg = await config(result());
    expect(() => StewardVerifier.fromEnvironment(cfg)).toThrow("approval is absent");
  });

  it("rejects target-style invalid approval values", async () => {
    const cfg = await config(result());
    expect(() => new StewardVerifier(cfg, "approve-me")).toThrow("valid approved declaration");
  });
});
