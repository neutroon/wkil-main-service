import { env } from "@config/env";
import * as Sentry from "@sentry/node";

type LogLevel = "info" | "warn" | "error" | "debug";
type LogMeta = Record<string, unknown> | undefined;

const SENSITIVE_KEY_PATTERN =
  /token|secret|password|authorization|cookie|api[_-]?key|access[_-]?token|refresh[_-]?token/i;
const SENSITIVE_QUERY_PATTERN =
  /([?&](?:access_token|token|client_secret|code|refresh_token|api_key)=)[^&]+/gi;
const MAX_META_DEPTH = 4;

function redactString(value: string) {
  return value.replace(SENSITIVE_QUERY_PATTERN, "$1[Filtered]");
}

function sanitizeMeta(value: unknown, depth = 0): unknown {
  if (depth > MAX_META_DEPTH) return "[MaxDepth]";
  if (value === null || value === undefined) return value;
  if (typeof value === "string") return redactString(value);
  if (typeof value === "number" || typeof value === "boolean") return value;
  if (value instanceof Error) {
    return {
      name: value.name,
      message: redactString(value.message),
      stack: value.stack ? redactString(value.stack) : undefined,
    };
  }
  if (Array.isArray(value)) {
    return value.slice(0, 50).map((item) => sanitizeMeta(item, depth + 1));
  }
  if (typeof value === "object") {
    const output: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      output[key] = SENSITIVE_KEY_PATTERN.test(key)
        ? "[Filtered]"
        : sanitizeMeta(item, depth + 1);
    }
    return output;
  }
  return String(value);
}

function shouldCaptureIssue(level: LogLevel, message: string, meta?: LogMeta) {
  if (level !== "error") return false;

  const code = Number((meta as any)?.code);
  const status = Number((meta as any)?.status);

  if (
    message === "meta.api.request_failed_V25_VERIFIED" &&
    code === 100 &&
    status === 400
  ) {
    return false;
  }

  return true;
}

class Logger {
  private formatMessage(level: LogLevel, message: string, meta?: LogMeta) {
    const timestamp = new Date().toISOString();
    return JSON.stringify({
      ts: timestamp,
      level,
      msg: message,
      ...meta,
    });
  }

  private forwardToSentry(level: LogLevel, message: string, meta?: LogMeta) {
    const sanitizedMeta = sanitizeMeta(meta) as Record<string, unknown> | undefined;
    const sentryLevel =
      level === "debug" ? "debug" : level === "warn" ? "warning" : level;

    Sentry.addBreadcrumb({
      category: "app.logger",
      level: sentryLevel as any,
      message,
      data: sanitizedMeta,
    });

    if (!shouldCaptureIssue(level, message, meta)) return;

    Sentry.captureMessage(message, {
      level: sentryLevel as any,
      tags: {
        log_level: level,
        log_message: message,
      },
      extra: sanitizedMeta,
    });
  }

  info(message: string, meta?: LogMeta) {
    console.log(this.formatMessage("info", message, meta));
    this.forwardToSentry("info", message, meta);
  }

  warn(message: string, meta?: LogMeta) {
    console.warn(this.formatMessage("warn", message, meta));
    this.forwardToSentry("warn", message, meta);
  }

  error(message: string, meta?: LogMeta) {
    console.error(this.formatMessage("error", message, meta));
    this.forwardToSentry("error", message, meta);
  }

  debug(message: string, meta?: LogMeta) {
    if (env.NODE_ENV !== "production") {
      console.log(this.formatMessage("debug", message, meta));
      this.forwardToSentry("debug", message, meta);
    }
  }
}

export const logger = new Logger();

