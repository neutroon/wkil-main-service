import { env } from "@config/env";

const STATIC_WEB_ORIGINS = new Set([
  "http://localhost:3000",
  "http://localhost:3001",
  "http://localhost:8080",
  "https://wkil.app",
  "https://www.wkil.app",
  "https://go.wkil.app",
  "https://app.wkil.app",
  "https://wkil.vercel.app",
  "https://wkil.netlify.app",
]);

export function isAllowedWkilWebOrigin(origin: string): boolean {
  return STATIC_WEB_ORIGINS.has(origin) ||
    origin.endsWith(".wkil.app") ||
    origin.endsWith(".vercel.app") ||
    origin === env.FRONTEND_URL;
}

