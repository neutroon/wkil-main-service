import { defineConfig } from "vitest/config";
import tsconfigPaths from "vite-tsconfig-paths";

export default defineConfig({
  plugins: [tsconfigPaths()],
  test: {
    globals: false,
    environment: "node",
    include: ["src/**/*.test.ts"],
    env: {
      NODE_ENV: "test",
      DATABASE_URL: "postgresql://test:test@127.0.0.1:1/test",
      JWT_SECRET: "test-only-jwt-secret",
      JWT_REFRESH_SECRET: "test-only-refresh-secret",
      VERIFICATION_TOKEN_SECRET: "test-only-verification-secret",
      PASSWORD_RESET_TOKEN_SECRET: "test-only-password-reset-secret",
      FB_APP_ID: "test-only-facebook-app-id",
      FB_APP_SECRET: "test-only-facebook-app-secret",
      FB_SYSTEM_USER_ACCESS_TOKEN: "test-only-facebook-system-token",
      MESSENGER_VERIFY_TOKEN: "test-only-messenger-verify-token",
      WHATSAPP_VERIFY_TOKEN: "test-only-whatsapp-verify-token",
      GEMINI_API_KEY: "test-only-gemini-key",
      REDIS_URL: "redis://127.0.0.1:1",
      FRONTEND_URL: "http://127.0.0.1:3000",
      R2_ACCESS_KEY: "test-only-r2-access-key",
      R2_SECRET_KEY: "test-only-r2-secret-key",
      CF_ACCOUNT_ID: "test-only-cloudflare-account-id",
      R2_BUCKET_NAME: "test-only-r2-bucket",
      R2_PUBLIC_URL: "http://127.0.0.1:1",
      SMTP_HOST: "127.0.0.1",
      SMTP_USER: "test-only-smtp-user",
      SMTP_PASS: "test-only-smtp-password",
      MONOLITH_AGENT_API_KEY: "test-only-agent-key",
      MONOLITH_SERVICE_TOKEN: "test-only-service-token",
      LANGSMITH_TRACING: "false",
    },
  },
});
