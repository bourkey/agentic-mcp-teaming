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

const McpConfig = z.object({
  port: z.number().int().positive().default(3100),
  host: z.string().default("127.0.0.1"),
  rootDir: z.string().default("."),
  toolAllowlist: z.array(z.string()),
  authTokenEnvVar: z.string().optional(),
  agents: z.record(z.string(), AgentEntry).default({}),
  consensus: z.object({
    maxRounds: z.number().int().positive().default(3),
  }).default({}),
  spawning: z.object({
    maxDepth: z.number().int().positive().default(2),
    maxConcurrentSubInvocations: z.number().int().positive().default(5),
    maxSessionInvocations: z.number().int().positive().default(50),
  }).default({}),
});

export type McpConfig = z.infer<typeof McpConfig>;

export function loadConfig(path = "mcp-config.json"): McpConfig {
  const raw = JSON.parse(readFileSync(path, "utf8")) as unknown;
  return McpConfig.parse(raw);
}
