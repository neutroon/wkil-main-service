import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { parse } from "yaml";
import { describe, expect, it } from "vitest";

const spec = parse(readFileSync(resolve("docs/openapi.yaml"), "utf8"));
describe("mobile auth OpenAPI credential contract", () => {
  it("uses a refresh-specific bearer scheme rather than an ignored Authorization parameter", () => {
    expect(spec.components.securitySchemes.mobileRefreshBearer).toMatchObject({ type: "http", scheme: "bearer", bearerFormat: "JWT" });
    for (const path of ["refresh", "logout"]) {
      const operation = spec.paths[`/v1/mobile/auth/${path}`].post;
      expect(operation.security).toContainEqual({ mobileRefreshBearer: [] });
      // OpenAPI cannot express body credentials as a security scheme: the empty
      // alternative permits JSON transport; refresh still requires a token.
      expect(operation.security).toContainEqual({});
      expect(operation.parameters ?? []).not.toContainEqual(expect.objectContaining({ name: "Authorization", in: "header" }));
      expect(operation.requestBody.required).toBe(false);
      expect(operation.requestBody.content["application/json"].schema.properties.refreshToken).toMatchObject({ type: "string", minLength: 1 });
    }
  });

  it("requires a token for JSON refresh but allows logout without a token", () => {
    const refresh = spec.paths["/v1/mobile/auth/refresh"].post;
    const logout = spec.paths["/v1/mobile/auth/logout"].post;
    expect(refresh.requestBody?.content["application/json"].schema.required).toEqual(["refreshToken"]);
    expect(logout.requestBody?.content["application/json"].schema.required ?? []).toEqual([]);
    expect(refresh.responses["401"]).toBeDefined();
    expect(logout.responses["200"]).toBeDefined();
  });
});
