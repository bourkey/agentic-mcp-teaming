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

describe("peerBus config block", () => {
  it("treats bus as disabled when block is absent", async () => {
    await setup();
    try {
      const path = await writeConfig("no-bus.json", { toolAllowlist: [] });
      const config = loadConfig(path);
      expect(config.peerBus).toBeUndefined();
    } finally {
      await teardown();
    }
  });

  it("accepts enabled: false explicitly", async () => {
    await setup();
    try {
      const path = await writeConfig("disabled.json", {
        toolAllowlist: [],
        peerBus: { enabled: false },
      });
      const config = loadConfig(path);
      expect(config.peerBus?.enabled).toBe(false);
    } finally {
      await teardown();
    }
  });

  it("applies notifier defaults verbatim when enabled: true is minimal", async () => {
    await setup();
    try {
      const path = await writeConfig("min.json", {
        toolAllowlist: [],
        peerBus: { enabled: true },
      });
      const config = loadConfig(path);
      expect(config.peerBus?.enabled).toBe(true);
      expect(config.peerBus?.notifier.tmuxEnabled).toBe(false);
      expect(config.peerBus?.notifier.displayMessageFormat).toBe("peer-bus: from {from} kind {kind}");
      expect(config.peerBus?.notifier.unreadTabStyle).toBe("bg=yellow");
    } finally {
      await teardown();
    }
  });

  it("rejects unknown key inside peerBus", async () => {
    await setup();
    try {
      const path = await writeConfig("unknown.json", {
        toolAllowlist: [],
        peerBus: { enabled: true, unknownField: "x" },
      });
      expect(() => loadConfig(path)).toThrow(/unknownField/);
    } finally {
      await teardown();
    }
  });

  it("rejects unknown key inside notifier", async () => {
    await setup();
    try {
      const path = await writeConfig("unknown-notifier.json", {
        toolAllowlist: [],
        peerBus: { enabled: true, notifier: { unknownField: "x" } },
      });
      expect(() => loadConfig(path)).toThrow(/unknownField/);
    } finally {
      await teardown();
    }
  });

  it("rejects displayMessageFormat containing a tmux format character", async () => {
    await setup();
    try {
      const path = await writeConfig("bad-format.json", {
        toolAllowlist: [],
        peerBus: { enabled: true, notifier: { displayMessageFormat: "from #(whoami)" } },
      });
      expect(() => loadConfig(path)).toThrow(/tmux format-language/);
    } finally {
      await teardown();
    }
  });

  it("rejects unreadTabStyle containing shell metacharacters", async () => {
    await setup();
    try {
      const path = await writeConfig("bad-style.json", {
        toolAllowlist: [],
        peerBus: { enabled: true, notifier: { unreadTabStyle: "; rm -rf /" } },
      });
      expect(() => loadConfig(path)).toThrow(/simple tmux style/);
    } finally {
      await teardown();
    }
  });

  it("accepts tmuxEnabled: true with default format and style", async () => {
    await setup();
    try {
      const path = await writeConfig("tmux-on.json", {
        toolAllowlist: [],
        peerBus: { enabled: true, notifier: { tmuxEnabled: true } },
      });
      const config = loadConfig(path);
      expect(config.peerBus?.notifier.tmuxEnabled).toBe(true);
      expect(config.peerBus?.notifier.displayMessageFormat).toBe("peer-bus: from {from} kind {kind}");
    } finally {
      await teardown();
    }
  });
});

describe("peerBus.autoWake schema — task 1.5-1.10", () => {
  it("loads a valid autoWake block with defaults", async () => {
    await setup();
    try {
      const path = await writeConfig("autowake-valid.json", {
        toolAllowlist: [],
        peerBus: {
          enabled: true,
          autoWake: {
            allowedCommands: { "claude-inbox": "/opsx:peer-inbox" },
          },
        },
      });
      const config = loadConfig(path);
      expect(config.peerBus?.autoWake?.allowedCommands["claude-inbox"]).toBe("/opsx:peer-inbox");
      expect(config.peerBus?.autoWake?.debounceMs).toBe(1000);
      expect(config.peerBus?.autoWake?.allowedPaneCommands).toEqual(["claude", "bash", "zsh", "sh"]);
    } finally {
      await teardown();
    }
  });

  it("rejects unknown fields under peerBus.autoWake via .strict()", async () => {
    await setup();
    try {
      const path = await writeConfig("autowake-unknown.json", {
        toolAllowlist: [],
        peerBus: {
          enabled: true,
          autoWake: {
            allowedCommands: { "k": "/v" },
            retry: true,
          },
        },
      });
      expect(() => loadConfig(path)).toThrow(/retry/);
    } finally {
      await teardown();
    }
  });

  it("rejects defaultCommand pointing at a missing key", async () => {
    await setup();
    try {
      const path = await writeConfig("autowake-dangling-default.json", {
        toolAllowlist: [],
        peerBus: {
          enabled: true,
          autoWake: {
            allowedCommands: { "present": "/ok" },
            defaultCommand: "missing",
          },
        },
      });
      expect(() => loadConfig(path)).toThrow(/defaultCommand.*missing/);
    } finally {
      await teardown();
    }
  });

  it("rejects empty-string allowedCommands value", async () => {
    await setup();
    try {
      const path = await writeConfig("autowake-empty-value.json", {
        toolAllowlist: [],
        peerBus: { enabled: true, autoWake: { allowedCommands: { "key-1": "" } } },
      });
      expect(() => loadConfig(path)).toThrow(/key-1.*non-empty/);
    } finally {
      await teardown();
    }
  });

  it("rejects whitespace-only allowedCommands value", async () => {
    await setup();
    try {
      const path = await writeConfig("autowake-ws-value.json", {
        toolAllowlist: [],
        peerBus: { enabled: true, autoWake: { allowedCommands: { "key-1": "   " } } },
      });
      expect(() => loadConfig(path)).toThrow(/key-1.*non-empty/);
    } finally {
      await teardown();
    }
  });

  it("rejects ANSI escape in allowedCommands value", async () => {
    await setup();
    try {
      const path = await writeConfig("autowake-ansi.json", {
        toolAllowlist: [],
        peerBus: { enabled: true, autoWake: { allowedCommands: { "key-1": "/opsx:inbox\x1b[31m" } } },
      });
      expect(() => loadConfig(path)).toThrow(/key-1.*disallowed byte/);
    } finally {
      await teardown();
    }
  });

  it("rejects newline in allowedCommands value", async () => {
    await setup();
    try {
      const path = await writeConfig("autowake-newline.json", {
        toolAllowlist: [],
        peerBus: { enabled: true, autoWake: { allowedCommands: { "key-1": "/opsx:inbox\narg" } } },
      });
      expect(() => loadConfig(path)).toThrow(/key-1.*disallowed byte/);
    } finally {
      await teardown();
    }
  });

  it("rejects carriage return in allowedCommands value", async () => {
    await setup();
    try {
      const path = await writeConfig("autowake-cr.json", {
        toolAllowlist: [],
        peerBus: { enabled: true, autoWake: { allowedCommands: { "key-1": "/opsx:inbox\rarg" } } },
      });
      expect(() => loadConfig(path)).toThrow(/key-1.*disallowed byte/);
    } finally {
      await teardown();
    }
  });

  it("rejects oversize allowedCommands value", async () => {
    await setup();
    try {
      const oversize = "a".repeat(513);
      const path = await writeConfig("autowake-big.json", {
        toolAllowlist: [],
        peerBus: { enabled: true, autoWake: { allowedCommands: { "key-1": oversize } } },
      });
      expect(() => loadConfig(path)).toThrow(/key-1.*exceeds 512/);
    } finally {
      await teardown();
    }
  });

  it("accepts 512-byte allowedCommands value at the boundary", async () => {
    await setup();
    try {
      const atBoundary = "a".repeat(512);
      const path = await writeConfig("autowake-boundary.json", {
        toolAllowlist: [],
        peerBus: { enabled: true, autoWake: { allowedCommands: { "k": atBoundary } } },
      });
      const config = loadConfig(path);
      expect(config.peerBus?.autoWake?.allowedCommands["k"]).toHaveLength(512);
    } finally {
      await teardown();
    }
  });

  it("accepts empty allowedCommands object (runtime-rejected elsewhere)", async () => {
    await setup();
    try {
      const path = await writeConfig("autowake-empty-map.json", {
        toolAllowlist: [],
        peerBus: { enabled: true, autoWake: { allowedCommands: {} } },
      });
      const config = loadConfig(path);
      expect(config.peerBus?.autoWake?.allowedCommands).toEqual({});
    } finally {
      await teardown();
    }
  });

  it("config without peerBus.autoWake block yields autoWake === undefined", async () => {
    await setup();
    try {
      const path = await writeConfig("no-autowake.json", {
        toolAllowlist: [],
        peerBus: { enabled: true },
      });
      const config = loadConfig(path);
      expect(config.peerBus?.autoWake).toBeUndefined();
    } finally {
      await teardown();
    }
  });

  it("rejects tab character in allowedCommands value", async () => {
    await setup();
    try {
      const path = await writeConfig("autowake-tab.json", {
        toolAllowlist: [],
        peerBus: { enabled: true, autoWake: { allowedCommands: { "k": "/v\targ" } } },
      });
      expect(() => loadConfig(path)).toThrow(/k.*disallowed byte/);
    } finally {
      await teardown();
    }
  });

  it("rejects DEL (0x7F) in allowedCommands value", async () => {
    await setup();
    try {
      const path = await writeConfig("autowake-del.json", {
        toolAllowlist: [],
        peerBus: { enabled: true, autoWake: { allowedCommands: { "k": "/v\x7f" } } },
      });
      expect(() => loadConfig(path)).toThrow(/k.*disallowed byte/);
    } finally {
      await teardown();
    }
  });

  it("accepts '~' (last printable ASCII) in allowedCommands value", async () => {
    await setup();
    try {
      const path = await writeConfig("autowake-tilde.json", {
        toolAllowlist: [],
        peerBus: { enabled: true, autoWake: { allowedCommands: { "k": "/v~" } } },
      });
      const config = loadConfig(path);
      expect(config.peerBus?.autoWake?.allowedCommands["k"]).toBe("/v~");
    } finally {
      await teardown();
    }
  });

  it("accepts custom debounceMs and allowedPaneCommands", async () => {
    await setup();
    try {
      const path = await writeConfig("autowake-custom.json", {
        toolAllowlist: [],
        peerBus: {
          enabled: true,
          autoWake: {
            allowedCommands: { "k": "/v" },
            debounceMs: 2500,
            allowedPaneCommands: ["fish", "bash"],
          },
        },
      });
      const config = loadConfig(path);
      expect(config.peerBus?.autoWake?.debounceMs).toBe(2500);
      expect(config.peerBus?.autoWake?.allowedPaneCommands).toEqual(["fish", "bash"]);
    } finally {
      await teardown();
    }
  });
});
