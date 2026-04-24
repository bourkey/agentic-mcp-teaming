import { readFileSync } from "fs";
import { z } from "zod";

const AgentEntry = z.object({
  cli: z.string(),
  specialty: z.string().optional(),
  canReview: z.boolean().default(true),
  canRevise: z.boolean().default(false),
  canImplement: z.boolean().default(false),
  allowSubInvocation: z.boolean().default(false),
});

const ReviewerEntry = z.object({
  stage: z.array(z.enum(["spec", "code"])).min(1),
  role: z.string(),
  specialty: z.string(),
  optional: z.boolean().default(false),
  cli: z.string().optional(),
});

export type ReviewerConfig = z.infer<typeof ReviewerEntry>;

const PeerBusNotifier = z.object({
  tmuxEnabled: z.boolean().default(false),
  displayMessageFormat: z
    .string()
    .regex(
      /^[^#`$;&|\n\r]*$/,
      "displayMessageFormat may not contain tmux format-language sequences or shell metacharacters (# ` $ ; & | newline)"
    )
    .default("peer-bus: from {from} kind {kind}"),
  unreadTabStyle: z
    .string()
    .regex(/^[A-Za-z0-9=,._-]+$/, "unreadTabStyle must be a simple tmux style spec")
    .default("bg=yellow"),
}).strict();

const AUTO_WAKE_VALUE_MAX_BYTES = 512;
// Rejects all C0 controls (including tab — tab at a shell prompt triggers
// completion, which can select an unintended binary that the trailing Enter
// then auto-confirms), DEL, and any non-ASCII-printable byte. Operator-authored
// allowlist values never need these.
const AUTO_WAKE_ILLEGAL_BYTE = /[\x00-\x1F\x7F]|[^\x20-\x7E]/;

const AllowedCommandsMap = z
  .record(z.string(), z.string())
  .superRefine((map, ctx) => {
    for (const [key, value] of Object.entries(map)) {
      if (value.trim().length === 0) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: [key],
          message: `peerBus.autoWake.allowedCommands[${key}]: value must be non-empty after trim`,
        });
        continue;
      }
      if (Buffer.byteLength(value, "utf8") > AUTO_WAKE_VALUE_MAX_BYTES) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: [key],
          message: `peerBus.autoWake.allowedCommands[${key}]: value exceeds ${AUTO_WAKE_VALUE_MAX_BYTES} bytes`,
        });
        continue;
      }
      if (AUTO_WAKE_ILLEGAL_BYTE.test(value)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: [key],
          message: `peerBus.autoWake.allowedCommands[${key}]: value contains disallowed byte (control char, newline, or non-ASCII-printable)`,
        });
      }
    }
  });

const PeerBusAutoWake = z
  .object({
    allowedCommands: AllowedCommandsMap,
    defaultCommand: z.string().optional(),
    debounceMs: z.number().int().nonnegative().default(1000),
    allowedPaneCommands: z.array(z.string()).default(["claude", "bash", "zsh", "sh"]),
  })
  .strict()
  .superRefine((block, ctx) => {
    if (block.defaultCommand !== undefined && !(block.defaultCommand in block.allowedCommands)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["defaultCommand"],
        message: `peerBus.autoWake.defaultCommand='${block.defaultCommand}' does not reference a key in allowedCommands`,
      });
    }
  });

const PeerBus = z.object({
  enabled: z.boolean().default(false),
  notifier: PeerBusNotifier.default({}),
  autoWake: PeerBusAutoWake.optional(),
}).strict();

const McpConfig = z.object({
  port: z.number().int().positive().default(3100),
  host: z.string().default("127.0.0.1"),
  rootDir: z.string().default("."),
  toolAllowlist: z.array(z.string()),
  authTokenEnvVar: z.string().optional(),
  agents: z.record(z.string(), AgentEntry).default({}),
  reviewers: z.record(z.string(), ReviewerEntry).default({}),
  consensus: z.object({
    maxRounds: z.number().int().positive().default(3),
  }).default({}),
  spawning: z.object({
    maxDepth: z.number().int().positive().default(2),
    maxConcurrentSubInvocations: z.number().int().positive().default(5),
    maxSessionInvocations: z.number().int().positive().default(50),
  }).default({}),
  peerBus: PeerBus.optional(),
});

export type PeerBusConfig = z.infer<typeof PeerBus>;

export type PeerBusAutoWakeConfig = z.infer<typeof PeerBusAutoWake>;

export type McpConfig = z.infer<typeof McpConfig>;

export function loadConfig(path = "mcp-config.json"): McpConfig {
  const raw = JSON.parse(readFileSync(path, "utf8")) as unknown;
  const config = McpConfig.parse(raw);

  for (const [id, reviewer] of Object.entries(config.reviewers)) {
    if (!reviewer.optional && !reviewer.cli) {
      if (!reviewer.role || !reviewer.specialty) {
        throw new Error(`Reviewer '${id}' is required and non-CLI but missing 'role' or 'specialty'`);
      }
    }
  }

  return config;
}
