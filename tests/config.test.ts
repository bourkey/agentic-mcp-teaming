import { describe, it, expect } from "vitest";
import { writeFile } from "fs/promises";
import { join } from "path";
import { tmpdir } from "os";
import { mkdtemp, rm } from "fs/promises";
import { loadConfig } from "../src/config.js";

let tmpDir: string;

async function setup() {
  tmpDir = await mkdtemp(join(tmpdir(), "config-test-"));
}

async function teardown() {
  await rm(tmpDir, { recursive: true, force: true });
}

async function writeConfig(name: string, obj: unknown): Promise<string> {
  const path = join(tmpDir, name);
  await writeFile(path, JSON.stringify(obj), "utf8");
  return path;
}

describe("McpConfig schema — task 1.7", () => {
  it("loads a valid registry", async () => {
    await setup();
    try {
      const path = await writeConfig("valid.json", {
        toolAllowlist: ["invoke_agent"],
        agents: {
          architect: { cli: "claude", specialty: "design", canReview: true, canRevise: true, canImplement: false, allowSubInvocation: true },
          implementer: { cli: "codex", canReview: true, canRevise: true, canImplement: true },
        },
      });
      const config = loadConfig(path);
      expect(config.agents["architect"]?.cli).toBe("claude");
      expect(config.agents["architect"]?.specialty).toBe("design");
      expect(config.agents["implementer"]?.canImplement).toBe(true);
      expect(config.agents["implementer"]?.allowSubInvocation).toBe(false);
    } finally {
      await teardown();
    }
  });

  it("applies default spawning values when omitted", async () => {
    await setup();
    try {
      const path = await writeConfig("defaults.json", {
        toolAllowlist: [],
        agents: { a: { cli: "claude", canReview: true, canRevise: true, canImplement: true } },
      });
      const config = loadConfig(path);
      expect(config.spawning.maxDepth).toBe(2);
      expect(config.spawning.maxConcurrentSubInvocations).toBe(5);
      expect(config.spawning.maxSessionInvocations).toBe(50);
      expect(config.consensus.maxRounds).toBe(3);
    } finally {
      await teardown();
    }
  });

  it("rejects an agent entry missing cli field", async () => {
    await setup();
    try {
      const path = await writeConfig("bad.json", {
        toolAllowlist: [],
        agents: { a: { canReview: true, canRevise: true, canImplement: true } },
      });
      expect(() => loadConfig(path)).toThrow();
    } finally {
      await teardown();
    }
  });

  it("accepts empty agents map (validation is in AgentRegistry, not config)", async () => {
    await setup();
    try {
      const path = await writeConfig("empty.json", { toolAllowlist: [], agents: {} });
      const config = loadConfig(path);
      expect(Object.keys(config.agents)).toHaveLength(0);
    } finally {
      await teardown();
    }
  });

  it("accepts custom spawning values", async () => {
    await setup();
    try {
      const path = await writeConfig("custom.json", {
        toolAllowlist: [],
        agents: { a: { cli: "claude", canReview: true, canRevise: true, canImplement: true } },
        spawning: { maxDepth: 4, maxConcurrentSubInvocations: 10, maxSessionInvocations: 100 },
      });
      const config = loadConfig(path);
      expect(config.spawning.maxDepth).toBe(4);
      expect(config.spawning.maxConcurrentSubInvocations).toBe(10);
      expect(config.spawning.maxSessionInvocations).toBe(100);
    } finally {
      await teardown();
    }
  });
});
