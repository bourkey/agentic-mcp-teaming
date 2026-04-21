export interface Logger {
  info(message: string, meta?: Record<string, unknown>): void;
  warn(message: string, meta?: Record<string, unknown>): void;
  error(message: string, meta?: Record<string, unknown>): void;
}

export const consoleLogger: Logger = {
  info(message, meta) {
    // eslint-disable-next-line no-console
    console.log(JSON.stringify({ level: "info", message, ...(meta ?? {}) }));
  },
  warn(message, meta) {
    // eslint-disable-next-line no-console
    console.warn(JSON.stringify({ level: "warn", message, ...(meta ?? {}) }));
  },
  error(message, meta) {
    // eslint-disable-next-line no-console
    console.error(JSON.stringify({ level: "error", message, ...(meta ?? {}) }));
  },
};
