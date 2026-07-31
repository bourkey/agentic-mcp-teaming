import { readdir, readFile } from "fs/promises";
import { join } from "path";
import { PhaseContext, runArtifactConsensus, transitionPhase } from "./base.js";

async function listMarkdownFiles(root: string, relativeDirectory = ""): Promise<string[]> {
  const entries = await readdir(join(root, relativeDirectory), { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    const relativePath = relativeDirectory === "" ? entry.name : `${relativeDirectory}/${entry.name}`;
    if (entry.isDirectory()) {
      files.push(...await listMarkdownFiles(root, relativePath));
    } else if (entry.isFile() && entry.name.endsWith(".md")) {
      files.push(relativePath);
    }
  }
  return files;
}

export async function runSpecsPhase(
  ctx: PhaseContext,
  specsDir: string
): Promise<void> {
  const specFiles = await listMarkdownFiles(specsDir);
  specFiles.sort();

  for (const specFile of specFiles) {
    const artifactId = `spec:${specFile.replace(/\//g, ":")}`;
    const content = await readFile(join(specsDir, specFile), "utf8");
    const outcome = await runArtifactConsensus(ctx, artifactId, content);
    ctx.logger.log({ type: "spec_consensus", specFile, outcome, sessionId: ctx.session.get().sessionId });
    if (outcome === "aborted") throw new Error(`Spec phase aborted at ${specFile}.`);
  }

  ctx.logger.log({ type: "phase_complete", phase: "spec", sessionId: ctx.session.get().sessionId });
  await transitionPhase(ctx, `spec:${specFiles[specFiles.length - 1] ?? "all"}`);
}
