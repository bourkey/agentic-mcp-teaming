import { readFileSync } from "fs";
import { join } from "path";

export interface CoordinatorConfig {
  host: string;
  port: number;
  rootDir: string;
  authToken?: string;
}

export class ConfigLoader {
  constructor(private readonly workspaceRoot: string) {}

  load(): CoordinatorConfig | null {
    const configPath = join(this.workspaceRoot, "mcp-config.json");
    try {
      const raw = readFileSync(configPath, "utf8");
      const parsed = JSON.parse(raw) as {
        host?: string;
        port?: number;
        rootDir?: string;
        authTokenEnvVar?: string;
      };
      const authToken = parsed.authTokenEnvVar ? process.env[parsed.authTokenEnvVar] : undefined;
      return {
        host: parsed.host ?? "127.0.0.1",
        port: parsed.port ?? 3100,
        rootDir: parsed.rootDir ?? ".",
        ...(authToken ? { authToken } : {}),
      };
    } catch {
      return null;
    }
  }

  sessionsPath(): string {
    return join(this.workspaceRoot, "sessions");
  }
}
