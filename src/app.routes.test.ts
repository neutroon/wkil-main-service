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
});
