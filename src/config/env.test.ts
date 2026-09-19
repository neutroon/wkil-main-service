import { describe, expect, it } from "vitest";
import { parseEnvironment } from "./env";

function validEnvironment(): Record<string, string> {
  return {
    NODE_ENV: "test",
    PORT: "8080",
    DATABASE_URL: "postgresql://test:test@127.0.0.1:5432/test",
    JWT_SECRET: "test-only-jwt-secret",
    JWT_REFRESH_SECRET: "test-only-refresh-secret",
    VERIFICATION_TOKEN_SECRET: "test-only-verification-secret",
    PASSWORD_RESET_TOKEN_SECRET: "test-only-password-reset-secret",
    FB_API_URL: "https://graph.facebook.com/v25.0",
    FB_APP_ID: "test-only-facebook-app-id",
    FB_APP_SECRET: "test-only-facebook-app-secret",
    FB_SYSTEM_USER_ACCESS_TOKEN: "test-only-facebook-system-token",
    MESSENGER_VERIFY_TOKEN: "test-only-messenger-verify-token",
    WHATSAPP_VERIFY_TOKEN: "test-only-whatsapp-verify-token",
    GEMINI_API_KEY: "test-only-gemini-key",
    REDIS_URL: "redis://127.0.0.1:6379",
    FRONTEND_URL: "http://127.0.0.1:3000",
    R2_ACCESS_KEY: "test-only-r2-access-key",
    R2_SECRET_KEY: "test-only-r2-secret-key",
    CF_ACCOUNT_ID: "test-only-cloudflare-account-id",
    R2_BUCKET_NAME: "test-only-r2-bucket",
    R2_PUBLIC_URL: "http://127.0.0.1:9000",
    SMTP_HOST: "127.0.0.1",
    SMTP_USER: "test-only-smtp-user",
    SMTP_PASS: "test-only-smtp-password",
    LANGGRAPH_API_URL: "http://127.0.0.1:8123",
    MONOLITH_AGENT_API_KEY: "test-only-agent-key",
    MONOLITH_SERVICE_TOKEN: "test-only-service-token",
  };
}

describe("backend environment", () => {
  it("requires the monolith Agent Server credential", () => {
    const values = validEnvironment();
    delete values.MONOLITH_AGENT_API_KEY;

    expect(() => parseEnvironment(values)).toThrow(/MONOLITH_AGENT_API_KEY/);
  });

  it("requires the Agent Server callback credential", () => {
    const values = validEnvironment();
    delete values.MONOLITH_SERVICE_TOKEN;

    expect(() => parseEnvironment(values)).toThrow(/MONOLITH_SERVICE_TOKEN/);
  });

  it("keeps the interactive BFF credential optional", () => {
    const values = validEnvironment();
    const parsed = parseEnvironment(values);

    expect(parsed.LANGGRAPH_API_KEY).toBeUndefined();
  });
});
