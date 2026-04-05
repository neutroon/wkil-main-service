import { Request, Response, NextFunction } from "express";
import prisma from "../config/prisma";
import type { WidgetInstall } from "@prisma/client";

export function parseAllowedOrigins(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((x): x is string => typeof x === "string" && x.length > 0);
}

function isOriginAllowed(
  origin: string | undefined,
  allowed: string[],
  isProduction: boolean,
): boolean {
  if (allowed.includes("*")) return true;
  if (!origin) {
    return !isProduction;
  }
  return allowed.some((o) => o === origin);
}

export type WidgetRequest = Request & { widgetInstall?: WidgetInstall };

/**
 * Resolves WidgetInstall by X-Widget-Site-Key (POST) or optional header on OPTIONS.
 * POST always requires the site key and allowlisted Origin.
 *
 * CORS preflight: browsers send OPTIONS without custom header *values* — only
 * Access-Control-Request-Headers lists `x-widget-site-key`. We answer 204 with
 * allowed methods/headers; the follow-up POST still validates key + origin.
 */
function sendWidgetPreflightCors(
  res: Response,
  origin: string | undefined,
  isProduction: boolean,
): void {
  if (origin) {
    res.setHeader("Access-Control-Allow-Origin", origin);
    res.setHeader("Vary", "Origin");
  } else if (!isProduction) {
    res.setHeader("Access-Control-Allow-Origin", "*");
  }
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader(
    "Access-Control-Allow-Headers",
    "Content-Type, X-Widget-Site-Key",
  );
  res.setHeader("Access-Control-Max-Age", "7200");
}

async function widgetInstallAndCorsImpl(
  req: WidgetRequest,
  res: Response,
  next: NextFunction,
): Promise<void> {
  const isProduction = process.env.NODE_ENV === "production";
  const origin = req.headers.origin;

  const siteKeyHeader = String(req.headers["x-widget-site-key"] ?? "").trim();
  const siteKeyBody =
    req.method === "POST" &&
    req.body &&
    typeof req.body === "object" &&
    typeof (req.body as { siteKey?: string }).siteKey === "string"
      ? String((req.body as { siteKey: string }).siteKey).trim()
      : "";

  const siteKey =
    req.method === "OPTIONS"
      ? siteKeyHeader
      : siteKeyHeader || siteKeyBody;

  if (req.method === "OPTIONS" && !siteKey) {
    sendWidgetPreflightCors(res, origin, isProduction);
    res.sendStatus(204);
    return;
  }

  if (!siteKey) {
    res.status(400).json({
      error:
        "Missing site key. Send X-Widget-Site-Key on POST (and on OPTIONS only if your client sends it).",
    });
    return;
  }

  if (isProduction && !origin && req.method !== "OPTIONS") {
    res.status(403).json({ error: "Origin header required" });
    return;
  }

  const install = await prisma.widgetInstall.findFirst({
    where: { publicSiteKey: siteKey, isActive: true },
  });

  if (!install) {
    res.status(403).json({ error: "Invalid or inactive widget" });
    return;
  }

  const allowed = parseAllowedOrigins(install.allowedOrigins);

  if (!isOriginAllowed(origin, allowed, isProduction)) {
    res.status(403).json({ error: "Origin not allowed for this widget" });
    return;
  }

  sendWidgetPreflightCors(res, origin, isProduction);

  if (req.method === "OPTIONS") {
    res.sendStatus(204);
    return;
  }

  req.widgetInstall = install;
  next();
}

export function widgetInstallAndCors(
  req: WidgetRequest,
  res: Response,
  next: NextFunction,
): void {
  void widgetInstallAndCorsImpl(req, res, next).catch(next);
}
