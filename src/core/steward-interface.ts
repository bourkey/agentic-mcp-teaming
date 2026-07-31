import { execFile } from "child_process";
import { promisify } from "util";
import { z } from "zod";
import { WorkflowPhase } from "../schema.js";
import type { StewardIntegrationConfig } from "../config.js";

const execFileAsync = promisify(execFile);

const InterfaceDeclaration = z.object({
  schema_version: z.number().int().positive(),
  supported_cli_version: z.string().min(1),
  openspec_contract: z.object({
    artifacts: z.array(z.string().min(1)),
    lifecycle_ops: z.array(z.string().min(1)),
    layout_marker: z.string().min(1),
  }),
  engine_phase_mapping: z.object({
    phases: z.array(WorkflowPhase),
    artifact_for_phase: z.record(WorkflowPhase, z.string().min(1)),
  }),
  transition_gates: z.object({
    gate: z.string().min(1),
    code_landing_phases: z.array(WorkflowPhase),
    code_landing_lifecycle: z.array(z.string().min(1)),
  }),
  verification_provider_protocol: z.object({
    schema_version: z.number().int().positive(),
    provider_tier: z.literal("container-hard"),
    result_schema_version: z.number().int().positive(),
    transition_authorizer_operation: z.string().min(1),
    required_evidence: z.array(z.string().min(1)),
  }),
});

export type StewardInterfaceDeclaration = z.infer<typeof InterfaceDeclaration>;

export class StewardInterface {
  private constructor(
    readonly declaration: StewardInterfaceDeclaration,
    readonly config: StewardIntegrationConfig
  ) {}

  static async load(config: StewardIntegrationConfig, repoRoot: string): Promise<StewardInterface> {
    const opts = { timeout: config.timeoutMs, maxBuffer: 1024 * 1024 };
    let raw: string;
    try {
      ({ stdout: raw } = await execFileAsync(config.interfaceCommand, ["--show"], opts));
      await execFileAsync(config.interfaceCommand, ["--check", repoRoot], opts);
    } catch (error) {
      throw new Error(`Steward interface unavailable or repository out-of-interface: ${String(error)}`);
    }
    let declaration: StewardInterfaceDeclaration;
    try {
      declaration = InterfaceDeclaration.parse(JSON.parse(raw) as unknown);
    } catch (error) {
      throw new Error(`Steward interface declaration is invalid: ${String(error)}`);
    }
    if (declaration.schema_version !== config.interfaceSchemaVersion) {
      throw new Error(
        `Steward interface schema ${String(declaration.schema_version)} is unsupported; expected ${String(config.interfaceSchemaVersion)}`
      );
    }
    if (declaration.verification_provider_protocol.result_schema_version !== config.resultSchemaVersion) {
      throw new Error("Steward verification result schema is unsupported");
    }
    const localPhases = WorkflowPhase.options;
    if (
      declaration.engine_phase_mapping.phases.length !== localPhases.length ||
      declaration.engine_phase_mapping.phases.some((phase, index) => phase !== localPhases[index])
    ) {
      throw new Error("Steward engine phase mapping does not match this coordinator");
    }
    return new StewardInterface(declaration, config);
  }

  phaseOrder(): typeof WorkflowPhase.options {
    return this.declaration.engine_phase_mapping.phases as typeof WorkflowPhase.options;
  }

  artifactForPhase(phase: z.infer<typeof WorkflowPhase>): string {
    const artifact = this.declaration.engine_phase_mapping.artifact_for_phase[phase];
    if (artifact === undefined) {
      throw new Error(`Steward interface has no artifact mapping for phase '${phase}'`);
    }
    return artifact;
  }
}
