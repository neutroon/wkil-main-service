import { encryptFacebookSecret } from "@modules/auth/core/tokenCrypto";
import { logger } from "@utils/logger";
import prisma from "@config/prisma";
import { AppError } from "@middlewares/errorHandler.middleware";
import { env } from "@config/env";

const GRAPH_API = "https://graph.facebook.com/v25.0";
// Meta Cloud API and Embedded Signup onboarding (Tech Provider) v25.0.
const OAUTH_GRAPH_API = "https://graph.facebook.com/v25.0";
// The "discover WABA accounts + phone numbers" step relies on Graph fields/endpoints.
const DISCOVERY_GRAPH_API = "https://graph.facebook.com/v25.0";

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
    throw new AppError(msg, 502);
  }

  return data as { access_token: string };
}

export async function exchangeCodeForToken(code: string, redirectUri?: string): Promise<string> {
  const appId = env.FB_APP_ID;
  const appSecret = env.FB_APP_SECRET;

  if (!appId || !appSecret) {
    throw new AppError("FB_APP_ID and FB_APP_SECRET must be set in environment", 500);
  }

  const trimmed = redirectUri?.trim() ?? "";

  // Embedded Signup code exchange appears to be strict about redirect_uri identity.
  // For the manual OAuth/dialog flow we control, we should send the exact redirectUri.
  // For the FB.login SDK flow, no redirectUri is passed → we try omit first, then empty.
  const attempts: Array<string | undefined> = [];

  if (trimmed !== "") {
    // Manual dialog flow: try the exact URI first, then trailing-slash variants.
    // 1) exact redirectUri as provided
    attempts.push(trimmed);

    // 2) trailing-slash normalized variants
    const withoutTrailingSlash = trimmed.endsWith("/") ? trimmed.slice(0, -1) : trimmed;
    const withTrailingSlash = trimmed.endsWith("/") ? trimmed : `${trimmed}/`;
    if (withoutTrailingSlash !== trimmed) attempts.push(withoutTrailingSlash);
    if (withTrailingSlash !== trimmed) attempts.push(withTrailingSlash);
  }

  // For SDK flow (trimmed === "") these are the ONLY attempts.
  // For manual flow they are fallbacks after the exact URI fails.
  // 3) omit redirect_uri entirely (most compatible with FB.login SDK codes)
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
      lastError = e instanceof AppError ? e : new AppError(msg, 502);
      const canRetry =
        i < uniqueAttempts.length - 1 && looksLikeRedirectUriMismatch(msg);
      if (!canRetry) throw lastError;
      logger.warn("whatsapp_oauth.token_exchange_retry_next_redirect", {
        failed_with: uri === undefined ? "(omitted)" : uri === "" ? "(empty)" : uri,
      });
    }
  }

  throw lastError ?? new AppError("Token exchange failed", 502);
}

// ─── Step 2: Discover all WABA accounts & phone numbers for this token ─────────

export async function discoverWabaAccounts(token: string): Promise<WabaAccount[]> {
  const appId = env.FB_APP_ID;
  const appSecret = env.FB_APP_SECRET;
  const systemUserToken = env.FB_SYSTEM_USER_ACCESS_TOKEN?.trim();
  if (!appId || !appSecret) {
    throw new AppError("FB_APP_ID and FB_APP_SECRET must be set in environment", 500);
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
    throw new AppError(lastDebugError, 502);
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
    throw new AppError(
      "No WhatsApp Business Accounts were found in debug_token granular_scopes",
      404
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
    throw new AppError(data?.error?.message || "Webhook subscription failed", 502);
  }

  logger.info("whatsapp_oauth.webhook_subscribed", { wabaId });
}

export async function unsubscribeWebhook(wabaId: string, token: string): Promise<void> {
  const res = await fetch(`${GRAPH_API}/${wabaId}/subscribed_apps`, {
    method: "DELETE",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
    },
  });

  const data = await res.json() as any;
  if (!res.ok) {
    logger.warn("whatsapp_oauth.webhook_unsubscription_failed", { wabaId, error: data });
    // We don't throw here to allow the DB deactivation to proceed even if Meta fails
  } else {
    logger.info("whatsapp_oauth.webhook_unsubscribed", { wabaId });
  }
}

// ─── Step 4: Save and upsert into DB ──────────────────────────────────────────

export async function saveWhatsAppAccount(params: {
  userId: number;
  wabaId: string;
  phoneNumberId: string;
  displayPhoneNumber: string;
  accessToken: string;
  businessProfileId?: number;
  connectionMode?: "BUSINESS_API" | "COEXISTENCE";
}) {
  const encryptedToken = encryptFacebookSecret(params.accessToken);
  // 1. PROFESSIONAL: Auto-detect the actual connection mode from Meta
  // We check if the number is still on the 'Biz App' to determine if it's COEXISTENCE.
  let connectionMode: "COEXISTENCE" | "BUSINESS_API" = params.connectionMode || "BUSINESS_API";
  try {
    const metaDetailsResponse = await fetch(
      `${env.FB_API_URL}/${params.phoneNumberId}?fields=is_on_biz_app`,
      {
        headers: { Authorization: `Bearer ${params.accessToken}` },
      }
    );
    const details = await metaDetailsResponse.json();
    
    if (details.is_on_biz_app === true) {
      connectionMode = "COEXISTENCE";
    } else if (details.is_on_biz_app === false) {
      connectionMode = "BUSINESS_API";
    }
    
    logger.info("whatsapp_oauth.mode_detected", {
      phoneNumberId: params.phoneNumberId,
      isOnBizApp: details.is_on_biz_app,
      finalMode: connectionMode
    });
  } catch (err) {
    logger.warn("whatsapp_oauth.mode_detection_failed", {
      phoneNumberId: params.phoneNumberId,
      error: err instanceof Error ? err.message : String(err)
    });
    // Fallback to user intent if detection fails
  }

  // 2. Check if number is already active for another user
  const existingActive = await prisma.whatsAppAccount.findFirst({
    where: {
      phoneNumberId: params.phoneNumberId,
      isActive: true,
      userId: { not: params.userId },
    },
  });

  if (existingActive) {
    throw new AppError(
      "This WhatsApp number is already active for another user. Please have the owner disconnect it first.",
      403,
    );
  }

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
      connectionMode,
      ...(params.businessProfileId && { businessProfileId: params.businessProfileId }),
    },
    update: {
      displayPhoneNumber: params.displayPhoneNumber,
      wabaId: params.wabaId,
      accessToken: encryptedToken,
      connectionMode,
      isActive: true,
      ...(params.businessProfileId && { businessProfileId: params.businessProfileId }),
    },
  });

  // PROFESSIONAL: Auto-register the number to Meta's servers immediately.
  // This moves the number from 'Pending' to 'Connected' without user intervention.
  try {
    await registerWhatsAppPhoneNumber({
      phoneNumberId: params.phoneNumberId,
      accessToken: params.accessToken,
    });
    logger.info("whatsapp_oauth.auto_registration_success", {
      phoneNumberId: params.phoneNumberId,
    });
  } catch (err: any) {
    // We log but don't fail the whole setup if registration fails (user can manually fix in dashboard later)
    logger.warn("whatsapp_oauth.auto_registration_failed", {
      phoneNumberId: params.phoneNumberId,
      error: err.message,
    });
  }

  logger.info("whatsapp_oauth.account_saved", {
    userId: params.userId,
    phoneNumberId: params.phoneNumberId,
    wabaId: params.wabaId,
    connectionMode,
  });

  // Strip the encrypted token before returning
  const { accessToken: _omit, ...safe } = account;
  return safe;
}

/**
 * ADMIN ONLY: Transfer a WhatsApp account and its history to another user/profile.
 */
export async function adminTransferAccount(params: {
  accountId: number;
  targetUserId: number;
  targetBusinessProfileId: number;
}) {
  const { accountId, targetUserId, targetBusinessProfileId } = params;

  const account = await prisma.whatsAppAccount.findUnique({
    where: { id: accountId },
  });

  if (!account) throw new AppError("WhatsApp account not found", 404);

  // Use a transaction to ensure atomic transfer
  return await prisma.$transaction(async (tx) => {
    // 0. Clean up target user's existing record for this number (if any)
    // This prevents the P2002 Unique Constraint error if they previously tried linking it.
    await tx.whatsAppAccount.deleteMany({
      where: {
        userId: targetUserId,
        phoneNumberId: account.phoneNumberId,
        id: { not: accountId },
      },
    });

    // 1. Move the account
    const updatedAccount = await tx.whatsAppAccount.update({
      where: { id: accountId },
      data: {
        userId: targetUserId,
        businessProfileId: targetBusinessProfileId,
        isActive: true,
      },
    });

    // 2. Move the conversation history
    // For WhatsApp, pageId is the phoneNumberId
    const movedConversations = await tx.conversation.updateMany({
      where: {
        pageId: account.phoneNumberId,
      },
      data: {
        businessProfileId: targetBusinessProfileId,
      },
    });

    logger.info("whatsapp_admin.account_transferred", {
      accountId,
      fromUser: account.userId,
      toUser: targetUserId,
      conversationsMoved: movedConversations.count,
    });

    return {
      account: updatedAccount,
      conversationsMoved: movedConversations.count,
    };
  });
}
/**
 * Finalizes the connection by registering the number with Meta's servers.
 * Required to move a number from 'PENDING' to 'CONNECTED'.
 */
async function registerWhatsAppPhoneNumber(params: {
  phoneNumberId: string;
  accessToken: string;
}) {
  const { phoneNumberId, accessToken } = params;
  const url = `${env.FB_API_URL}/${phoneNumberId}/register`;

  try {
    const response = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${accessToken}`,
      },
      body: JSON.stringify({
        messaging_product: "whatsapp",
        pin: "123456", // Default registration PIN; user can change in Meta settings if needed.
      }),
    });

    const data = await response.json();

    if (!response.ok) {
      // If already registered, Meta might return a 400 with a specific subcode.
      // We check if it's already success.
      if (data.error?.message?.includes("already registered")) {
        return { success: true, alreadyRegistered: true };
      }
      throw new Error(data.error?.message || "Registration failed");
    }

    return { success: true };
  } catch (err) {
    throw err;
  }
}






