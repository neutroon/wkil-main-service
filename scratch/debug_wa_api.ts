/**
 * End-to-end debug script: logs in as nbilha161@gmail.com, 
 * then calls /v1/whatsapp/conversations to verify what the 
 * authenticated session actually returns.
 */
import fetch from "node-fetch";

const BASE = "http://127.0.0.1:8080";

async function run() {
  // 1. Login
  console.log("Step 1: Logging in...");
  const loginRes = await fetch(`${BASE}/v1/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email: "nbilha161@gmail.com", password: "102003000@Aa" }),
  });

  const cookies = loginRes.headers.get("set-cookie") ?? "";
  const loginBody = await loginRes.json() as any;
  console.log("Login status:", loginRes.status);
  console.log("User role:", loginBody?.role, "| userId:", loginBody?.id);

  if (!loginRes.ok) {
    console.error("Login failed:", JSON.stringify(loginBody));
    return;
  }

  // Extract accessToken cookie
  const cookieHeader = cookies.split(",").join("; ");

  // 2. Call WA conversations
  console.log("\nStep 2: Calling /v1/whatsapp/conversations...");
  const waRes = await fetch(`${BASE}/v1/whatsapp/conversations?page=1&limit=20`, {
    headers: { Cookie: cookieHeader },
  });

  const waBody = await waRes.json() as any;
  console.log("WA status:", waRes.status);
  console.log("WA meta:", JSON.stringify(waBody.meta));
  console.log("WA data count:", waBody.data?.length);
  if (waBody.data?.length > 0) {
    console.log("First conversation:", JSON.stringify(waBody.data[0], null, 2));
  }
  if (waBody.error) {
    console.error("WA error:", JSON.stringify(waBody));
  }
}

run().catch(console.error);
