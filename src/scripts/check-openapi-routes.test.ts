import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

// eslint-disable-next-line @typescript-eslint/no-require-imports
const { getExpectedRoutes } = require("../../scripts/check-openapi-routes.js") as {
  getExpectedRoutes: (options: { root: string; appPath: string }) => Set<string>;
};

const fixtureRoots: string[] = [];

afterEach(() => {
  for (const fixtureRoot of fixtureRoots.splice(0)) {
    rmSync(fixtureRoot, { recursive: true, force: true });
  }
});

describe("OpenAPI route discovery", () => {
  it("discovers nested routes with prefixes and middleware before routers", () => {
    const fixtureRoot = mkdtempSync(join(tmpdir(), "openapi-routes-"));
    fixtureRoots.push(fixtureRoot);
    const appPath = join(fixtureRoot, "src", "app.ts");
    const routePath = join(
      fixtureRoot,
      "src",
      "modules",
      "auth",
      "mobile",
      "mobileAuth.routes.ts",
    );

    mkdirSync(join(fixtureRoot, "src", "modules", "auth", "mobile"), {
      recursive: true,
    });
    writeFileSync(
      appPath,
      [
        'import mobileAuthRoutes from "@modules/auth/mobile/mobileAuth.routes";',
        "const mobileApp = express.Router();",
        'mobileApp.use("/auth", authMiddleware, mobileAuthRoutes);',
        "const apiApp = express.Router();",
        'apiApp.use("/mobile", mobileMiddleware, mobileApp);',
        'app.use("/v1", apiApp);',
      ].join("\n"),
    );
    writeFileSync(
      routePath,
      [
        'import { Router } from "express";',
        "const router = Router();",
        'router.post("/login", handler);',
        'router.post("/google", handler);',
        'router.post("/refresh", handler);',
        'router.post("/logout", handler);',
        'router.get("/me", handler);',
        "export default router;",
      ].join("\n"),
    );

    const routes = getExpectedRoutes({ root: fixtureRoot, appPath });

    expect([...routes].sort()).toEqual([
      "GET /v1/mobile/auth/me",
      "POST /v1/mobile/auth/google",
      "POST /v1/mobile/auth/login",
      "POST /v1/mobile/auth/logout",
      "POST /v1/mobile/auth/refresh",
    ]);
  });
});
