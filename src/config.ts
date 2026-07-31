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
  cmuxEnabled: z.boolean().default(false),
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
// then auto-confirms), DEL, any non-ASCII-printable byte, and backslash.
// The backslash rejection prevents cmux CLI from auto-unescaping \n/\t
// sequences in allowlist values into actual newlines/tabs in the pane.
const AUTO_WAKE_ILLEGAL_BYTE = /[\x00-\x1F\x5C\x7F]|[^\x20-\x7E]/;

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

const PeerBusSession = z.object({
  inactivityTtlMs: z.number().int().nonnegative().default(600000),
}).strict();

export type PeerBusSessionConfig = z.infer<typeof PeerBusSession>;

const PeerBus = z.object({
  enabled: z.boolean().default(false),
  backend: z.enum(["tmux", "cmux"]).default("tmux"),
  notifier: PeerBusNotifier.default({}),
  autoWake: PeerBusAutoWake.optional(),
  session: PeerBusSession.optional(),
}).strict();

const StewardIntegration = z.object({
  interfaceCommand: z.string().min(1).default("orchestration-interface"),
  providerCommand: z.string().min(1).default("container-verification-provider"),
  interfaceSchemaVersion: z.number().int().positive().default(1),
  resultSchemaVersion: z.number().int().positive().default(1),
  approvedDeclarationEnvVar: z.string().regex(/^[A-Z][A-Z0-9_]*$/),
  timeoutMs: z.number().int().positive().default(30_000),
}).strict();

export type StewardIntegrationConfig = z.infer<typeof StewardIntegration>;

const TlsHsts = z
  .object({
    enabled: z.boolean().default(true),
    maxAge: z.number().int().nonnegative().default(31536000),
    includeSubDomains: z.boolean().default(false),
    preload: z.boolean().default(false),
  })
  .strict()
  .superRefine((h, ctx) => {
    if (h.preload && (!h.includeSubDomains || h.maxAge < 31536000)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["preload"],
        message: "tls.hsts.preload requires includeSubDomains=true and maxAge >= 31536000",
      });
    }
  });

// Server-side TLS. Note: there is intentionally NO option to disable certificate
// verification (no insecure/skip-verify flag) — clients must trust the server CA.
const Tls = z
  .object({
    // certFile must be the server's FULL chain (leaf + any intermediates) — Node's
    // `ca` option below is for verifying *client* certs (mTLS), not for sending the
    // server's chain. A leaf signed directly by the trusted CA also works.
    certFile: z.string(),
    keyFile: z.string(),
    caFile: z.string().optional(),
    requireClientCert: z.boolean().optional(),
    hsts: TlsHsts.default({}),
  })
  .strict()
  .superRefine((t, ctx) => {
    if (t.requireClientCert === true && t.caFile === undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["caFile"],
        message: "tls.caFile is required when tls.requireClientCert is true",
      });
    }
  });

export type TlsConfig = z.infer<typeof Tls>;

const McpConfig = z.object({
  port: z.number().int().positive().default(3100),
  host: z.string().default("127.0.0.1"),
  // Host that spawned sub-agents use to call back (COORDINATOR_MCP_URL). Set this
  // to a routable address when `host` is a wildcard (0.0.0.0/::), which is not a
  // valid destination. Defaults to `host`.
  advertisedHost: z.string().optional(),
  rootDir: z.string().default("."),
  toolAllowlist: z.array(z.string()),
  authTokenEnvVar: z.string().optional(),
  tls: Tls.optional(),
  allowInsecureNonLoopback: z.boolean().optional(),
  // Operator-provided DNS-rebinding allowlist (the hostnames clients send in the
  // Host header). Not auto-derived from `host` — the bind address is not the
  // client-visible hostname. Empty/absent ⇒ DNS-rebinding protection stays off.
  allowedHosts: z.array(z.string()).optional(),
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
  steward: StewardIntegration.optional(),
});

export type PeerBusConfig = z.infer<typeof PeerBus>;
export type PeerBusBackend = "tmux" | "cmux";
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
