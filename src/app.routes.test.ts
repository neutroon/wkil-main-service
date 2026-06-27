import { describe, expect, it } from "vitest";
import { readFileSync } from "fs";
import path from "path";

describe("app route mounts", () => {
  const appSource = readFileSync(path.join(__dirname, "app.ts"), "utf8");

  it("mounts Agent Actions on the canonical API path only", () => {
    expect(appSource).toContain('app.use("/v1/agent-actions", agentActionRoutes)');
    expect(appSource).not.toContain("/v1/external-data");
  });

  it("mounts OpenAPI and Swagger docs before protected enterprise routes", () => {
    const docsMount = appSource.indexOf('app.use("/", docsRoutes)');
    const protectedMount = appSource.indexOf("app.use(authenticateToken)");

    expect(appSource).toContain('from "@modules/docs/docs.routes"');
    expect(docsMount).toBeGreaterThan(-1);
    expect(protectedMount).toBeGreaterThan(-1);
    expect(docsMount).toBeLessThan(protectedMount);
  });

  it("keeps the health check public for platform probes", () => {
    const healthRoute = appSource.indexOf('app.get("/v1/health"');
    const protectedMount = appSource.indexOf("app.use(authenticateToken)");

    expect(healthRoute).toBeGreaterThan(-1);
    expect(protectedMount).toBeGreaterThan(-1);
    expect(healthRoute).toBeLessThan(protectedMount);
  });

  // ── Mobile auth contract ───────────────────────────────────
  // The mobile auth routes (`/v1/mobile/auth/*`) MUST be mounted
  // before the global `authenticateToken` wall. Otherwise the
  // native app's login / refresh / logout calls hit
  // `authenticateToken` first and bounce back with
  // `401 INVALID_TOKEN` ("Invalid token") instead of the public
  // auth errors. This was the root cause of a live-server outage
  // after a deploy — the mobile sub-app was silently moved below
  // the auth wall, and the Flutter app's login was unreachable.
  // These tests fail the build if anyone reorders the mounts.
  it("mounts the mobile sub-app before the global auth wall", () => {
    const mobileMount = appSource.indexOf('app.use("/v1/mobile", mobileApp)');
    const protectedMount = appSource.indexOf("app.use(authenticateToken)");

    expect(mobileMount).toBeGreaterThan(-1);
    expect(protectedMount).toBeGreaterThan(-1);
    expect(mobileMount).toBeLessThan(protectedMount);
  });

  it("wires the mobile auth router into the mobile sub-app", () => {
    expect(appSource).toContain("mobileAuthRoutes");
    expect(appSource).toMatch(/mobileApp\.use\(mobileAuthRoutes\)/);
  });
});
