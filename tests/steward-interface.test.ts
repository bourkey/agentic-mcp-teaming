import { afterEach, describe, expect, it } from "vitest";
import { chmod, mkdtemp, rm, writeFile } from "fs/promises";
import { join } from "path";
import { tmpdir } from "os";
import { StewardInterface } from "../src/core/steward-interface.js";
import type { StewardIntegrationConfig } from "../src/config.js";

const dirs: string[] = [];

async function fakeInterface(declaration: unknown, checkExit = 0): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "steward-interface-test-"));
  dirs.push(dir);
  const path = join(dir, "interface");
  const payload = JSON.stringify(declaration).replaceAll("'", "'\\''");
  await writeFile(
    path,
    `#!/bin/sh\ncase "$1" in --show) printf '%s\\n' '${payload}' ;; --check) exit ${checkExit} ;; *) exit 3 ;; esac\n`,
    "utf8"
  );
  await chmod(path, 0o755);
  return path;
}

function declaration(phases = ["proposal", "design", "spec", "task", "implementation", "review"]) {
  return {
    schema_version: 1,
    supported_cli_version: "1.6.0",
    openspec_contract: {
      artifacts: ["proposal", "specs", "design", "tasks"],
      lifecycle_ops: ["propose", "apply", "archive"],
      layout_marker: "openspec/config.yaml",
    },
    engine_phase_mapping: {
      phases,
      artifact_for_phase: {
        proposal: "proposal",
        design: "design",
        spec: "specs",
        task: "tasks",
        implementation: "tasks",
        review: "tasks",
      },
    },
    transition_gates: {
      gate: "execution-verified-gate",
      code_landing_phases: ["implementation", "review"],
      code_landing_lifecycle: ["archive"],
    },
    verification_provider_protocol: {
      schema_version: 1,
      provider_tier: "container-hard",
      result_schema_version: 1,
      transition_authorizer_operation: "--authorize-transition",
      required_evidence: ["repo", "commit", "tree", "authenticator"],
    },
  };
}

function config(interfaceCommand: string): StewardIntegrationConfig {
  return {
    interfaceCommand,
    providerCommand: "container-verification-provider",
    interfaceSchemaVersion: 1,
    resultSchemaVersion: 1,
    approvedDeclarationEnvVar: "STEWARD_APPROVED_DECLARATION",
    timeoutMs: 1000,
  };
}

afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("StewardInterface", () => {
  it("loads a conformant declaration and provides artifact mappings", async () => {
    const command = await fakeInterface(declaration());
    const iface = await StewardInterface.load(config(command), ".");
    expect(iface.artifactForPhase("spec")).toBe("specs");
    expect(iface.phaseOrder()).toEqual(["proposal", "design", "spec", "task", "implementation", "review"]);
  });

  it("fails before workflow startup when conformance check fails", async () => {
    const command = await fakeInterface(declaration(), 2);
    await expect(StewardInterface.load(config(command), ".")).rejects.toThrow("out-of-interface");
  });

  it("rejects phase drift", async () => {
    const command = await fakeInterface(declaration(["proposal", "design", "task"]));
    await expect(StewardInterface.load(config(command), ".")).rejects.toThrow();
  });

  it("rejects result schema drift", async () => {
    const drifted = declaration();
    drifted.verification_provider_protocol.result_schema_version = 2;
    const command = await fakeInterface(drifted);
    await expect(StewardInterface.load(config(command), ".")).rejects.toThrow("result schema");
  });
});
