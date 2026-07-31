import { execFile, spawn } from "child_process";
import { createHash } from "crypto";
import { promisify } from "util";
import { z } from "zod";
import type { StewardIntegrationConfig } from "../config.js";

const execFileAsync = promisify(execFile);

const CommandOutcome = z.object({
  command: z.string(),
  exit: z.number().nullable(),
  outcome: z.string(),
  duration_seconds: z.number(),
  output: z.object({
    stdout_bytes: z.number(),
    stderr_bytes: z.number(),
    truncated: z.boolean(),
  }).passthrough(),
}).passthrough();

const VerificationResult = z.object({
  verdict: z.enum(["pass", "fail", "not-verifiable"]),
  reason: z.string(),
  evidence: z.object({
    repo: z.string(),
    commit: z.string().regex(/^[0-9a-f]{40,64}$/),
    tree: z.string().regex(/^[0-9a-f]{40,64}$/),
    provider: z.string(),
    declaration: z.object({
      source: z.string(),
      digest: z.string().regex(/^[0-9a-f]{40,64}$/),
      approved_digest: z.string().regex(/^[0-9a-f]{40,64}$/),
    }),
    attestation: z.unknown(),
  }),
  commands: z.array(CommandOutcome),
  authenticator: z.object({
    alg: z.string(),
    key_id: z.string(),
    value: z.string().min(1),
  }).nullable(),
});

export type StewardVerificationEvidence = {
  candidateCommit: string;
  candidateTree: string;
  approvedDeclarationDigest: string;
  gateResultDigest: string;
  gateVerdict: "pass" | "fail" | "not-verifiable";
  gateProvider: string;
  attestation: unknown;
  commandOutcomes: Array<{
    commandDigest: string;
    exit: number | null;
    outcome: string;
    duration_seconds: number;
    output: { stdout_bytes: number; stderr_bytes: number; truncated: boolean };
  }>;
};

function runWithInput(command: string, args: string[], input: string, timeoutMs: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ["pipe", "ignore", "pipe"] });
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`Steward transition authorization timed out after ${String(timeoutMs)}ms`));
    }, timeoutMs);
    child.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString("utf8"); });
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code === 0) resolve();
      else reject(new Error(`Steward transition authorization blocked (${String(code)}): ${stderr.trim()}`));
    });
    child.stdin.end(input);
  });
}

export class StewardVerifier {
  constructor(
    private readonly config: StewardIntegrationConfig,
    private readonly approvedDeclarationDigest: string
  ) {
    if (!/^[0-9a-f]{40,64}$/.test(approvedDeclarationDigest)) {
      throw new Error("Trusted Steward driver did not supply a valid approved declaration digest");
    }
  }

  static fromEnvironment(config: StewardIntegrationConfig): StewardVerifier {
    const digest = process.env[config.approvedDeclarationEnvVar];
    if (digest === undefined) {
      throw new Error(
        `Trusted Steward driver approval is absent: ${config.approvedDeclarationEnvVar} is not set`
      );
    }
    return new StewardVerifier(config, digest);
  }

  approvedDigest(): string {
    return this.approvedDeclarationDigest;
  }

  async verifyImplementation(repoRoot: string, candidateCommit: string): Promise<StewardVerificationEvidence> {
    const { stdout: candidateTree } = await execFileAsync(
      "git",
      ["rev-parse", `${candidateCommit}^{tree}`],
      { cwd: repoRoot, timeout: this.config.timeoutMs }
    );
    let rawResult = "";
    try {
      ({ stdout: rawResult } = await execFileAsync(
        this.config.providerCommand,
        [
          repoRoot,
          "--commit",
          candidateCommit,
          "--approved-declaration",
          this.approvedDeclarationDigest,
        ],
        { timeout: this.config.providerTimeoutMs, maxBuffer: 4 * 1024 * 1024 }
      ));
    } catch (error) {
      const output = (error as { stdout?: string }).stdout;
      if (typeof output !== "string" || output.trim() === "") {
        throw new Error(`Steward verification provider unavailable: ${String(error)}`);
      }
      rawResult = output;
    }

    const parsed = VerificationResult.parse(JSON.parse(rawResult) as unknown);
    const tree = candidateTree.trim();
    if (
      parsed.evidence.commit !== candidateCommit ||
      parsed.evidence.tree !== tree ||
      parsed.evidence.declaration.approved_digest !== this.approvedDeclarationDigest ||
      parsed.evidence.declaration.digest !== this.approvedDeclarationDigest ||
      parsed.evidence.provider !== "container"
    ) {
      throw new Error("Steward verification result is stale or bound to different immutable inputs");
    }

    await runWithInput(
      this.config.interfaceCommand,
      ["--authorize-transition", "implementation"],
      rawResult,
      this.config.timeoutMs
    );

    if (parsed.verdict !== "pass") {
      throw new Error(`Steward verification blocked integration: ${parsed.verdict} (${parsed.reason})`);
    }
    return {
      candidateCommit,
      candidateTree: tree,
      approvedDeclarationDigest: this.approvedDeclarationDigest,
      gateResultDigest: createHash("sha256").update(rawResult).digest("hex"),
      gateVerdict: parsed.verdict,
      gateProvider: parsed.evidence.provider,
      attestation: parsed.evidence.attestation,
      commandOutcomes: parsed.commands.map((command) => ({
        commandDigest: createHash("sha256").update(command.command).digest("hex"),
        exit: command.exit,
        outcome: command.outcome,
        duration_seconds: command.duration_seconds,
        output: {
          stdout_bytes: command.output.stdout_bytes,
          stderr_bytes: command.output.stderr_bytes,
          truncated: command.output.truncated,
        },
      })),
    };
  }
}
