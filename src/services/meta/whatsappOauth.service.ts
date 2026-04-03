import { encryptFacebookSecret } from "../../utils/tokenCrypto";
import { logger } from "../../utils/logger";
import prisma from "../../config/prisma";

const GRAPH_API = "https://graph.facebook.com/v25.0";

// ─── Types ────────────────────────────────────────────────────────────────────

export interface WabaPhoneNumber {
  id: string;               // phoneNumberId
  display_phone_number: string;
  verified_name: string;
}

export interface WabaAccount {
  id: string;               // wabaId
  name: string;
  phone_numbers: WabaPhoneNumber[];
}

// ─── Step 1: Exchange short-lived SDK code for a long-lived User Access Token ──

/** Meta often returns this when redirect_uri does not match what the dialog used. */
function looksLikeRedirectUriMismatch(message: string): boolean {
  return /redirect_uri|verification code|validating verification/i.test(message);
}

/**
 * WhatsApp Embedded Signup uses FB.login with response_type=code. Meta does not document a
 * single rule: the dialog may bind the code to redirect_uri "" OR to the current page URL.
 * Community reports (e.g. SO #77555576) and prod behavior show empty string is often required.
 * We try "" first, then the client-provided URI when it differs, and only retry on mismatch errors.
 *
 * @see https://developers.facebook.com/docs/whatsapp/embedded-signup/implementation
 */
async function exchangeCodeForTokenOnce(
  code: string,
  redirectUriForRequest: string,
  appId: string,
  appSecret: string,
): Promise<{ access_token: string }> {
  const url = new URL(`${GRAPH_API}/oauth/access_token`);
  url.searchParams.set("client_id", appId);
  url.searchParams.set("client_secret", appSecret);
  url.searchParams.set("code", code);
  url.searchParams.set("redirect_uri", redirectUriForRequest);

  const res = await fetch(url.toString());
  const data = (await res.json()) as {
    access_token?: string;
    error?: { message?: string };
  };

  if (!res.ok || !data.access_token) {
    const msg = data?.error?.message || "Token exchange failed";
    logger.error("whatsapp_oauth.token_exchange_failed", {
      status: res.status,
      error: data,
      redirect_uri_attempt: redirectUriForRequest === "" ? "(empty)" : redirectUriForRequest,
      url: url.toString().replace(appSecret, "REDACTED"),
    });
    throw new Error(msg);
  }

  return data as { access_token: string };
}

export async function exchangeCodeForToken(code: string, redirectUri?: string): Promise<string> {
  const appId = process.env.FB_APP_ID;
  const appSecret = process.env.FB_APP_SECRET;

  if (!appId || !appSecret) {
    throw new Error("FB_APP_ID and FB_APP_SECRET must be set in environment");
  }

  const trimmed = redirectUri?.trim() ?? "";
  const attempts: string[] = [""];
  if (trimmed !== "") attempts.push(trimmed);

  let lastError: Error | null = null;

  for (let i = 0; i < attempts.length; i++) {
    const uri = attempts[i];
    try {
      const data = await exchangeCodeForTokenOnce(code, uri, appId, appSecret);
      logger.info("whatsapp_oauth.token_exchanged", {
        redirect_uri_used: uri === "" ? "(empty)" : uri,
      });
      return data.access_token;
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      lastError = e instanceof Error ? e : new Error(msg);
      const canRetry =
        i < attempts.length - 1 && looksLikeRedirectUriMismatch(msg);
      if (!canRetry) throw lastError;
      logger.warn("whatsapp_oauth.token_exchange_retry_next_redirect", {
        failed_with: uri === "" ? "(empty)" : uri,
      });
    }
  }

  throw lastError ?? new Error("Token exchange failed");
}

// ─── Step 2: Discover all WABA accounts & phone numbers for this token ─────────

export async function discoverWabaAccounts(token: string): Promise<WabaAccount[]> {
  // Fetch all WhatsApp Business Accounts the token has access to
  const wabaRes = await fetch(
    `${GRAPH_API}/me/businesses?fields=whatsapp_business_accounts{id,name}&access_token=${token}`,
  );
  const wabaData = await wabaRes.json() as any;

  if (!wabaRes.ok) {
    logger.error("whatsapp_oauth.waba_discovery_failed", { error: wabaData });
    throw new Error(wabaData?.error?.message || "WABA discovery failed");
  }

  const accounts: WabaAccount[] = [];

  // Flatten businesses -> waba accounts
  const businesses: any[] = wabaData.data || [];
  for (const biz of businesses) {
    const wabas: any[] = biz.whatsapp_business_accounts?.data || [];
    for (const waba of wabas) {
      // Fetch phone numbers for this WABA
      const phonesRes = await fetch(
        `${GRAPH_API}/${waba.id}/phone_numbers?fields=id,display_phone_number,verified_name&access_token=${token}`,
      );
      const phonesData = await phonesRes.json() as any;
      accounts.push({
        id: waba.id,
        name: waba.name,
        phone_numbers: phonesData.data || [],
      });
    }
  }

  logger.info("whatsapp_oauth.waba_accounts_discovered", { count: accounts.length });
  return accounts;
}

// ─── Step 3: Subscribe our App webhook to a WABA ──────────────────────────────

export async function subscribeWebhook(wabaId: string, token: string): Promise<void> {
  const res = await fetch(`${GRAPH_API}/${wabaId}/subscribed_apps`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
    },
  });

  const data = await res.json() as any;
  if (!res.ok) {
    logger.error("whatsapp_oauth.webhook_subscription_failed", { wabaId, error: data });
    throw new Error(data?.error?.message || "Webhook subscription failed");
  }

  logger.info("whatsapp_oauth.webhook_subscribed", { wabaId });
}

// ─── Step 4: Save and upsert into DB ──────────────────────────────────────────

export async function saveWhatsAppAccount(params: {
  userId: number;
  wabaId: string;
  phoneNumberId: string;
  displayPhoneNumber: string;
  accessToken: string;
  businessProfileId?: number;
}) {
  const encryptedToken = encryptFacebookSecret(params.accessToken);

  const account = await prisma.whatsAppAccount.upsert({
    where: {
      userId_phoneNumberId: {
        userId: params.userId,
        phoneNumberId: params.phoneNumberId,
      },
    },
    create: {
      userId: params.userId,
      phoneNumberId: params.phoneNumberId,
      displayPhoneNumber: params.displayPhoneNumber,
      wabaId: params.wabaId,
      accessToken: encryptedToken,
      ...(params.businessProfileId && { businessProfileId: params.businessProfileId }),
    },
    update: {
      displayPhoneNumber: params.displayPhoneNumber,
      wabaId: params.wabaId,
      accessToken: encryptedToken,
      isActive: true,
      ...(params.businessProfileId && { businessProfileId: params.businessProfileId }),
    },
  });

  logger.info("whatsapp_oauth.account_saved", {
    userId: params.userId,
    phoneNumberId: params.phoneNumberId,
    wabaId: params.wabaId,
  });

  // Strip the encrypted token before returning
  const { accessToken: _omit, ...safe } = account;
  return safe;
}
