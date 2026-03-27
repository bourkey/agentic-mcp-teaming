import { readFile } from "fs/promises";
import { glob } from "fs/promises";
import { PhaseContext, runArtifactConsensus, transitionPhase } from "./base.js";

export async function runSpecsPhase(
  ctx: PhaseContext,
  specsDir: string
): Promise<void> {
  const specFiles: string[] = [];
  for await (const f of (glob as (pattern: string, options: { cwd: string }) => AsyncIterable<string>)(
    "**/*.md",
    { cwd: specsDir }
  )) {
    specFiles.push(f);
  }
  specFiles.sort();

  for (const specFile of specFiles) {
    const artifactId = `spec:${specFile.replace(/\//g, ":")}`;
    const content = await readFile(`${specsDir}/${specFile}`, "utf8");
    const outcome = await runArtifactConsensus(ctx, artifactId, content);
    ctx.logger.log({ type: "spec_consensus", specFile, outcome, sessionId: ctx.session.get().sessionId });
    if (outcome === "aborted") throw new Error(`Spec phase aborted at ${specFile}.`);
  }

  ctx.logger.log({ type: "phase_complete", phase: "spec", sessionId: ctx.session.get().sessionId });
  await transitionPhase(ctx, `spec:${specFiles[specFiles.length - 1] ?? "all"}`);
}
