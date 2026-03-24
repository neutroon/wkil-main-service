/**
 * Minimal structured logger for production (JSON lines to stdout).
 * Replace with pino/winston later if we need transports.
 */

type LogLevel = "debug" | "info" | "warn" | "error";

const LEVEL_ORDER: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
};

function envLevel(): LogLevel {
  const l = (process.env.LOG_LEVEL || "").toLowerCase();
  if (l === "debug" || l === "info" || l === "warn" || l === "error") return l;
  return process.env.NODE_ENV === "production" ? "info" : "debug";
}

function shouldLog(level: LogLevel): boolean {
  return LEVEL_ORDER[level] >= LEVEL_ORDER[envLevel()];
}

function write(level: LogLevel, msg: string, meta?: Record<string, unknown>) {
  if (!shouldLog(level)) return;
  const line = JSON.stringify({
    ts: new Date().toISOString(),
    level,
    msg,
    ...meta,
  });
  if (level === "error") console.error(line);
  else console.log(line);
}

export const logger = {
  debug: (msg: string, meta?: Record<string, unknown>) =>
    write("debug", msg, meta),
  info: (msg: string, meta?: Record<string, unknown>) =>
    write("info", msg, meta),
  warn: (msg: string, meta?: Record<string, unknown>) =>
    write("warn", msg, meta),
  error: (msg: string, meta?: Record<string, unknown>) =>
    write("error", msg, meta),
};
