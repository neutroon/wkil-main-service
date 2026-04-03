import { encryptFacebookSecret } from "../../utils/tokenCrypto";
import { logger } from "../../utils/logger";
import prisma from "../../config/prisma";

const GRAPH_API = "https://graph.facebook.com/v25.0";
// Meta Embedded Signup onboarding (Tech Provider) docs show token exchange using v21.0.
// We keep other calls on `GRAPH_API` but align the token exchange endpoint version.
const OAUTH_GRAPH_API = "https://graph.facebook.com/v21.0";
// The "discover WABA accounts + phone numbers" step relies on Graph fields/endpoints
// that appear to differ by version; use v21.0 to match the Embedded Signup token exchange.
const DISCOVERY_GRAPH_API = "https://graph.facebook.com/v21.0";

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
 * single rule: the dialog may bind the code to redirect_uri omitted, "", or to the current page URL.
 * Community reports and prod behavior show Meta can be sensitive to omit-vs-empty and trailing slashes.
 * This service tries multiple `redirect_uri` exchange variants on mismatch errors.
 *
 * @see https://developers.facebook.com/docs/whatsapp/embedded-signup/implementation
 */
async function exchangeCodeForTokenOnce(
  code: string,
  appId: string,
  appSecret: string,
  redirectUriForRequest?: string,
): Promise<{ access_token: string }> {
  const url = new URL(`${OAUTH_GRAPH_API}/oauth/access_token`);
  url.searchParams.set("client_id", appId);
  url.searchParams.set("client_secret", appSecret);
  url.searchParams.set("code", code);
  // Meta's Embedded Signup redirect_uri strictness can differ depending on whether
  // the parameter is omitted vs explicitly set to an empty string.
  if (redirectUriForRequest !== undefined) {
    url.searchParams.set("redirect_uri", redirectUriForRequest);
  }

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
      redirect_uri_attempt:
        redirectUriForRequest === undefined
          ? "(omitted)"
          : redirectUriForRequest === ""
            ? "(empty)"
            : redirectUriForRequest,
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

  // Embedded Signup code exchange appears to be strict about redirect_uri identity.
  // For the manual OAuth/dialog flow we control, we should send the exact redirectUri.
  // For compatibility, we still keep omit/empty as fallback attempts.
  const attempts: Array<string | undefined> = [];

  if (trimmed !== "") {
    // 1) exact redirectUri as provided
    attempts.push(trimmed);

    // 2) trailing-slash normalized variants
    const withoutTrailingSlash = trimmed.endsWith("/") ? trimmed.slice(0, -1) : trimmed;
    const withTrailingSlash = trimmed.endsWith("/") ? trimmed : `${trimmed}/`;
    if (withoutTrailingSlash !== trimmed) attempts.push(withoutTrailingSlash);
    if (withTrailingSlash !== trimmed) attempts.push(withTrailingSlash);
  }

  // 3) omit redirect_uri entirely
  attempts.push(undefined);
  // 4) explicitly empty string
  attempts.push("");

  // Remove duplicates while keeping order.
  const seen = new Set<string>();
  const uniqueAttempts = attempts.filter((a) => {
    const key = a === undefined ? "(omitted)" : a === "" ? "(empty)" : a;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  let lastError: Error | null = null;

  for (let i = 0; i < uniqueAttempts.length; i++) {
    const uri = uniqueAttempts[i];
    try {
      const data = await exchangeCodeForTokenOnce(code, appId, appSecret, uri);
      logger.info("whatsapp_oauth.token_exchanged", {
        redirect_uri_used:
          uri === undefined ? "(omitted)" : uri === "" ? "(empty)" : uri,
      });
      return data.access_token;
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      lastError = e instanceof Error ? e : new Error(msg);
      const canRetry =
        i < uniqueAttempts.length - 1 && looksLikeRedirectUriMismatch(msg);
      if (!canRetry) throw lastError;
      logger.warn("whatsapp_oauth.token_exchange_retry_next_redirect", {
        failed_with: uri === undefined ? "(omitted)" : uri === "" ? "(empty)" : uri,
      });
    }
  }

  throw lastError ?? new Error("Token exchange failed");
}

// ─── Step 2: Discover all WABA accounts & phone numbers for this token ─────────

export async function discoverWabaAccounts(token: string): Promise<WabaAccount[]> {
  const appId = process.env.FB_APP_ID;
  const appSecret = process.env.FB_APP_SECRET;
  const systemUserToken = process.env.FB_SYSTEM_USER_ACCESS_TOKEN?.trim();
  if (!appId || !appSecret) {
    throw new Error("FB_APP_ID and FB_APP_SECRET must be set in environment");
  }

  // Prefer system user token when available, but fall back to app access token.
  // `debug_token` accepts an app access token in the Authorization header.
  const debugAuthCandidates: Array<{
    label: "system_user" | "app_access";
    token: string;
  }> = [];
  if (systemUserToken) {
    debugAuthCandidates.push({ label: "system_user", token: systemUserToken });
  }
  debugAuthCandidates.push({ label: "app_access", token: `${appId}|${appSecret}` });

  let debugData:
    | {
        data?: {
          granular_scopes?: Array<{
            scope?: string;
            target_ids?: Array<string | number>;
          }>;
        };
        error?: { message?: string; code?: number };
      }
    | undefined;
  let debugSucceeded = false;
  let lastDebugError = "WABA discovery failed (debug_token)";

  // Step A: Resolve shared WABA IDs from the newly minted business token.
  for (const candidate of debugAuthCandidates) {
    const debugRes = await fetch(
      `${DISCOVERY_GRAPH_API}/debug_token?input_token=${encodeURIComponent(token)}`,
      {
        headers: {
          Authorization: `Bearer ${candidate.token}`,
        },
      },
    );
    debugData = (await debugRes.json()) as {
      data?: {
        granular_scopes?: Array<{
          scope?: string;
          target_ids?: Array<string | number>;
        }>;
      };
      error?: { message?: string; code?: number };
    };

    if (debugRes.ok && debugData?.data) {
      debugSucceeded = true;
      logger.info("whatsapp_oauth.debug_token_ok", {
        auth_strategy: candidate.label,
      });
      break;
    }

    lastDebugError = debugData?.error?.message || lastDebugError;
    logger.warn("whatsapp_oauth.debug_token_failed", {
      auth_strategy: candidate.label,
      error: debugData,
    });
  }

  if (!debugSucceeded || !debugData?.data) {
    logger.error("whatsapp_oauth.waba_discovery_failed", { error: debugData });
    throw new Error(lastDebugError);
  }

  const granularScopes = debugData?.data?.granular_scopes || [];
  const wabaIds = Array.from(
    new Set(
      granularScopes
        .filter((s) => s.scope === "whatsapp_business_management")
        .flatMap((s) => s.target_ids || [])
        .map((id) => String(id)),
    ),
  );

  if (wabaIds.length === 0) {
    throw new Error(
      "No WhatsApp Business Accounts were found in debug_token granular_scopes",
    );
  }

  // Step B: Fetch WABA details + phone numbers.
  const accounts: WabaAccount[] = [];
  for (const wabaId of wabaIds) {
    const wabaRes = await fetch(
      `${DISCOVERY_GRAPH_API}/${wabaId}?fields=id,name&access_token=${token}`,
    );
    const wabaData = (await wabaRes.json()) as {
      id?: string;
      name?: string;
      error?: { message?: string };
    };
    if (!wabaRes.ok) {
      logger.warn("whatsapp_oauth.waba_fetch_failed", { wabaId, error: wabaData });
      continue;
    }

    const phonesRes = await fetch(
      `${DISCOVERY_GRAPH_API}/${wabaId}/phone_numbers?fields=id,display_phone_number,verified_name&access_token=${token}`,
    );
    const phonesData = (await phonesRes.json()) as {
      data?: WabaPhoneNumber[];
      error?: { message?: string };
    };
    if (!phonesRes.ok) {
      logger.warn("whatsapp_oauth.waba_phone_numbers_failed", {
        wabaId,
        error: phonesData,
      });
      continue;
    }

    accounts.push({
      id: wabaData.id || wabaId,
      name: wabaData.name || `WABA ${wabaId}`,
      phone_numbers: phonesData.data || [],
    });
  }

  logger.info("whatsapp_oauth.waba_accounts_discovered", {
    count: accounts.length,
    resolvedWabaIds: wabaIds.length,
  });
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
