import { Request, Response, NextFunction } from "express";
import prisma from "../config/prisma";
import type { WidgetInstall } from "@prisma/client";

export function parseAllowedOrigins(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter(
    (x): x is string => typeof x === "string" && x.length > 0,
  );
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

  const siteKey = siteKeyHeader || siteKeyBody;

  if (!siteKey) {
    if (req.method === "OPTIONS") return next(); // Already handled in app.ts
    res.status(400).json({ error: "Missing X-Widget-Site-Key header." });
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
    res.status(403).json({ error: "Invalid or inactive widget site key" });
    return;
  }

  const allowed = parseAllowedOrigins(install.allowedOrigins);

  // In development, automatically allow localhost
  const isLocal =
    origin && (origin.includes("localhost") || origin.includes("127.0.0.1"));

  if (!isLocal && !isOriginAllowed(origin, allowed, isProduction)) {
    console.warn(`[CORS] Origin not allowed for widget ${siteKey}: ${origin}`);
    res.status(403).json({
      error:
        "Origin not allowed for this widget. Please add it to allowed origins in settings.",
    });
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
