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

  it("mounts the signed order webhook raw parser and public router before JSON and auth", () => {
    const rawWebhookMount = appSource.indexOf(
      '"/v1/order-integrations/:integrationKey/events"',
    );
    const jsonParser = appSource.indexOf('app.use(express.json({ limit: "10mb" }))');
    const publicOrderMount = appSource.indexOf(
      'app.use("/v1/order-integrations", orderConfirmationPublicRoutes)',
    );
    const generalLimiterMount = appSource.indexOf("app.use(generalLimiter)");
    const protectedMount = appSource.indexOf("app.use(authenticateToken)");

    expect(appSource).toContain("orderWebhookLimiter");
    expect(appSource).toContain('express.raw({ type: "application/json", limit: "256kb" })');
    expect(rawWebhookMount).toBeGreaterThan(-1);
    expect(publicOrderMount).toBeGreaterThan(-1);
    expect(generalLimiterMount).toBeGreaterThan(-1);
    expect(rawWebhookMount).toBeLessThan(publicOrderMount);
    expect(publicOrderMount).toBeLessThan(generalLimiterMount);
    expect(generalLimiterMount).toBeLessThan(jsonParser);
    expect(publicOrderMount).toBeLessThan(jsonParser);
    expect(publicOrderMount).toBeLessThan(protectedMount);
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

  it("mounts order-confirmation management routes behind authentication, verification, and CSRF", () => {
    const authMount = appSource.indexOf("app.use(authenticateToken)");
    const verifiedMount = appSource.indexOf("app.use(requireVerified)");
    const csrfMount = appSource.indexOf("app.use(validateCsrfToken)");
    const managementMount = appSource.indexOf('app.use("/v1", orderConfirmationRoutes)');
    const publicOrderMount = appSource.indexOf(
      'app.use("/v1/order-integrations", orderConfirmationPublicRoutes)',
    );

    expect(appSource).toContain("orderConfirmationRoutes");
    expect(managementMount).toBeGreaterThan(-1);
    expect(authMount).toBeLessThan(managementMount);
    expect(verifiedMount).toBeLessThan(managementMount);
    expect(csrfMount).toBeLessThan(managementMount);
    expect(publicOrderMount).toBeLessThan(authMount);
  });

  it("keeps the management router inside the exact protected middleware sequence", () => {
    expect(appSource).toMatch(
      /app\.use\(authenticateToken\);\s*app\.use\(requireVerified\);\s*app\.use\(validateCsrfToken\)[\s\S]*?app\.use\("\/v1", orderConfirmationRoutes\);/,
    );
  });

  it("does not mount the legacy Copilot (moved to agent-svc)", () => {
    expect(appSource).not.toContain('app.use("/v1/copilot", copilotRoutes)');
    expect(appSource).not.toContain('from "@modules/copilot/copilot.routes"');
  });

  it("mounts the assistant feedback routes (new LangGraph copilot)", () => {
    expect(appSource).toContain('app.use("/v1/assistant", copilotRoutes)');
  });
});

