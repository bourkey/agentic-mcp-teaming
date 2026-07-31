export interface Logger {
  info(message: string, meta?: Record<string, unknown>): void;
  warn(message: string, meta?: Record<string, unknown>): void;
  error(message: string, meta?: Record<string, unknown>): void;
}

export const consoleLogger: Logger = {
  info(message, meta) {

    console.log(JSON.stringify({ level: "info", message, ...(meta ?? {}) }));
  },
  warn(message, meta) {

    console.warn(JSON.stringify({ level: "warn", message, ...(meta ?? {}) }));
  },
  error(message, meta) {

    console.error(JSON.stringify({ level: "error", message, ...(meta ?? {}) }));
  },
};
