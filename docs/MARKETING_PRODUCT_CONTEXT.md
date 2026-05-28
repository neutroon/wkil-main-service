# Wkil Backend — Marketing & Product Context

**Purpose:** Single structured reference for positioning, website copy, sales decks, and feature lists.  
**Scope:** Features implemented in this repository (`back-end`).  
**API base path:** `/v1` (see `src/app.ts`).

---

## 1. One-line positioning options

- **Social + AI operations platform** for teams that run Facebook Pages and want AI-assisted content, engagement, and optional WhatsApp customer chat tied to a structured business profile.
- **AI-native business profile** that powers RAG-grounded assistants across Meta channels, with optional CRM handoff and live data tools.

---

## 2. Product pillars (how to market the whole)

| Pillar | What it is | Buyer value |
|--------|------------|-------------|
| **Business brain** | Rich business profile + vector RAG (PostgreSQL `pgvector`) | Answers stay on-brand and grounded in *your* facts, not generic AI fluff. |
| **Content engine** | Gemini text + optional Vertex Imagen images | Faster post creation with voice/tone from the profile. |
| **Facebook operations** | OAuth, posting, scheduling, comments, analytics, activity logs | One backend for page workflow and accountability. |
| **Conversational Meta** | Messenger + WhatsApp webhooks, shared conversation store, AI + human reply | Same “brain” on the channels customers already use. |
| **Revenue / ops hooks** | CRM webhook integration + configurable external APIs as AI tools | Leads and live data flow into your stack. |
| **Enterprise hygiene** | JWT auth, roles, rate limits, security middleware, encrypted Meta tokens, structured AI guardrails | Sellable to teams that care about safety and control. |

---

## 3. Feature catalog (granular — use for bullets, FAQs, comparisons)

### 3.1 Authentication & sessions

- User **registration** and **login** with validation and **strict rate limiting** on auth endpoints.
- **JWT access** (short-lived) + **refresh** flow; tokens also available via **HTTP-only cookies** (secure cookie settings in production).
- **Logout** and **token refresh** endpoints.
- **Current user** profile (`/v1/auth/me`).

### 3.2 Roles, hierarchy, and governance

- **Four roles:** `super_admin`, `admin`, `manager`, `user` (string on `User` model).
- **Admin** can: register admins, create managers, create users, list/update users, deactivate/reactivate, permanently delete users, list leads, manage user–manager assignments, view platform-wide Facebook analytics, list any user’s Facebook accounts, deactivate Facebook accounts by id.
- **Manager** can: dashboard for managed users, list “my users” / “my managers”, view a managed user and their analytics, deactivate/reactivate managed users, create users, (admin-only subset) manage assignments.
- **Manager access** checks ensure managers only touch users assigned to them (enforced in middleware/controllers).

### 3.3 Business profile (core “knowledge product”)

- **CRUD** for business profiles (authenticated): create, list (with FAQs + linked Facebook page ids), update, delete.
- Rich fields: name, identity, target audience, **voice** & **tone**, products/services, expected intents, policies, phones, hours, address, optional **FAQs**.
- On **create:** marks user as having a business profile and triggers **full RAG ingestion** (embedding + chunk storage).
- On **update:** **partial re-ingestion** — only chunk types affected by changed fields are recomputed (efficiency + cost story).
- **RAG retrieval API** for a profile: `POST /v1/business-profile/:id/retrieve` with `{ query }` returns relevant chunks (for debugging, internal tools, or future UIs).
- **RAG ingestion state:** `ragIngested` / `ragIngestedAt` on profile (AI channels can show a friendly “still setting up” message until ready).

### 3.4 RAG / knowledge base (technical selling points)

- **Embeddings:** Gemini embedding model; chunks stored with **pgvector** (`vector(768)`).
- **Chunking** driven by typed chunk categories (identity, products, contact, FAQs, intents, etc.).
- **Similarity threshold** tunable via env (`RAG_MIN_SIMILARITY`) for retrieval quality vs recall.
- **Ingestion** wipes and rebuilds chunks on full ingest; **targeted updates** on profile edit.

### 3.5 AI social content generation

- **POST `/v1/content/generate-post`:** topic, optional keywords, context, length (`short` | `medium` | `long`), optional **AI image** flag.
- Pulls **voice/tone/identity/audience** from selected business profile (or first profile fallback).
- **Optional image pipeline:** Vertex AI / Imagen path + **Cloudinary** upload for hosting.
- Returns structured payload: text, hashtags, optional image URL / metadata.
- **Dedicated rate limit** for content generation (per IP, hourly cap).
- **Rich error mapping** for auth, quota, network, and config failures (market as “production-minded API”).

### 3.6 Image upload

- **POST `/v1/content/upload-image`:** authenticated multipart upload through **Multer** + **Cloudinary**; returns URL, public id, dimensions, size.

### 3.7 Website onboarding / scraping (lead-in to profile)

- **POST `/v1/scrape/analyze-website`:** accepts a URL; calls external **scraping service** (configurable `SCRAPING_SERVICE_URL`, default Wkil scraper).
- Flow: scrape homepage → **AI picks strategic links** → optional **batch scrape** → **AI extracts structured business identity** for onboarding forms.
- Bilingual UX detail: Arabic error message on failure path (good for MENA marketing).

### 3.8 Facebook — connection & pages

- **OAuth URL** generation with redirect URI.
- **Callback** exchanges code, fetches Facebook user info, stores **encrypted** long-lived token, records **device metadata** (user agent, platform, browser, mobile/desktop).
- **List pages** for a user access token; optional **persist pages** to DB linked to internal or Facebook user id.
- **List connected Facebook accounts** for the logged-in user.
- **Deactivate** a Facebook account (soft deactivate pattern in service).
- **Switch device** metadata for an account (multi-device / audit story).

### 3.9 Facebook — publishing & engagement

- **Create post** on a page (message, optional image URL, page access token); optional **activity log** when `facebookAccountId` passed.
- **Schedule post** with Unix schedule time.
- **List page posts** for a page.
- **Get comments** on a post.
- **Reply to comment**.
- **Rate limiting** on Facebook mutation routes.

### 3.10 Facebook — analytics & admin views

- **Per-user analytics** over configurable day window (default 30).
- **Admin analytics** (role `admin`) under `/v1/facebook/admin/analytics` — cross-user/platform view.
- **Admin** routes under `/v1/admin/...` for deeper Facebook account visibility and deactivation.

### 3.11 Facebook Page ↔ Business profile linking

- **Link** a page to a `businessProfileId` (validates ownership).
- **Unlink** business profile from a page.

### 3.12 Messenger (customer AI channel)

- **Webhook verification** (GET) with verify token.
- **Webhook receiver** (POST): **HMAC signature verification** on **raw body** (Meta requirement).
- **Idempotency:** optional dedupe by `message.mid` (`ProcessedMessengerMessage`) with graceful handling if table missing (logged warning).
- **In-process FIFO queue** so HTTP returns 200 quickly while AI + Send API run async.
- **Mark seen + typing indicator** before reply.
- **Conversation** stored by page id + sender; **message history** for model context with char budget cap.
- **RAG + shared system prompt** + **Gemini tool loop**: CRM capture + external API tools when configured.
- **Fallback replies** on errors; **“not ingested yet”** message if RAG not ready.
- **AI truthfulness guardrails** (code-level): deterministic checks after tool use; safe fallbacks; structured logs (`ai.guardrail.blocked_response`).

### 3.13 WhatsApp (customer AI channel + inbox)

- **Embedded signup / OAuth-style flow:** exchange code, discover WABA + phone numbers, subscribe webhook, save account; **preview** endpoint returns accounts + short-lived **exchange ref** cache (TTL + max size) to avoid double code exchange.
- **Manual account registration** endpoint (encrypted token storage).
- **List / deactivate / link / unlink** business profile for WhatsApp accounts (authenticated).
- **Webhook verification** + **incoming messages** with HMAC on raw body.
- **Idempotency** by `wamid` (`ProcessedWhatsAppMessage`).
- **In-process queue** + **read + typing indicator** Cloud API call when `wamid` present.
- Same **RAG + AI engine + CRM + external tools** as Messenger; passes **customer phone** for CRM defaults.
- **Conversations API** (mounted under `/v1/whatsapp/conversations`):
  - Paginated **list conversations** for user’s phone numbers.
  - Paginated **messages** for one conversation (with display phone enrichment).
  - **PATCH read** stub (updates timestamp hook for UI — documented as placeholder).
  - **Human send:** POST message from dashboard → Cloud API → persist as `model` role (human-in-the-loop selling point).

### 3.14 CRM integration (lead capture from AI)

- **Per business profile:** list integrations, **upsert** by provider (e.g. webhook, HubSpot-style naming), store `webhookUrl`, `apiKey`, **JSON field mapping** for dynamic lead schema.
- **Delete** integration.
- AI **`capture_lead`** tool built from mapping; **push to CRM** with validation feedback loop to the model.
- **Enterprise guardrails:** no “saved” messaging unless CRM confirms success; policy hooks for templates.

### 3.15 External data sources (AI “live data” tools)

- **CRUD-style API** per business profile: list, create, update (by id), delete.
- Each source: name, **description** (used to help the model know when to call), URL, HTTP method (default GET), optional **headers** and **queryParams**, **expectedParamsSchema** for Gemini function parameters.
- Runtime: **timeout-bound fetch** (e.g. 8s), canonical **verification envelope** for guardrails (read results treated as verified when non-empty JSON; explicit failures marked failed).

### 3.16 Leads (marketing funnel)

- **Public POST** `/v1/leads` — capture name, email, optional url/message (classic landing-page integration).
- **GET** `/v1/leads` — list all (used by admin route; note: route itself is not admin-guarded in `lead.routes.ts` — position honestly or fix in product security review).

### 3.17 Dashboard (Facebook-centric today)

- **Activity feed** from `FacebookActivity` with account + page context, empty states.
- **Stats:** connected accounts/pages, posts created/scheduled, comments replied, reach, rolling daily performance snippet.

### 3.18 Health & operations

- **GET `/v1/health`:** status, timestamp, uptime, memory, CPU load avg, OS — useful for uptime monitors and SLAs.

### 3.19 Security & platform hardening (B2B checklist)

- **Helmet**-style security headers, **CORS** configuration, **request sanitization**, **body size limits** (JSON/urlencoded and raw webhook paths).
- **Global IP rate limit** + specialized limits: auth, content, Facebook, admin, manager, **Messenger webhook**, **WhatsApp webhook**.
- **`trust proxy`** configurable via `TRUST_PROXY` for ngrok / load balancers (correct rate-limit client IPs).
- **Meta webhook:** `X-Hub-Signature-256` verification (`src/utils/metaWebhook.ts`).
- **Token encryption** for stored Meta tokens (`tokenCrypto`).

### 3.20 Database & migrations

- **PostgreSQL** + **Prisma** migrations (versioned schema history).
- **`prisma/MIGRATIONS.md`** — workflow for `migrate dev` / `migrate deploy` vs `db push`.

---

## 4. AI behavior (messaging) — what to promise in marketing

- **Shared persona prompt** for WhatsApp + Messenger: XML-tagged rules, plain text (no markdown stars), bullet formatting, strict tool-use and “no wait, call tool now” style rules.
- **Truthfulness rules in prompt** + **deterministic enforcement** after tool execution: blocks unsafe “confirmed/done” claims when evidence is missing; blocks unsupported **promise language** (callbacks, “we’ll call”, etc.) unless policy allows; returns **explicit safe fallback strings** (never silent failure).
- **Configurable policy object** in code (`AiTruthfulnessPolicy`) for future per-tenant tuning (defaults today).
- **Observability:** structured logs on guardrail blocks with `ruleId`, channel, `businessProfileId`, and action evidence buckets.

---

## 5. Integrations & external services (ecosystem slide)

| Integration | Role |
|-------------|------|
| **Google Gemini** | Chat/tools, embeddings, generic text generation |
| **Google Vertex AI** | Image generation path for social content |
| **Cloudinary** | Image storage for uploads and generated assets |
| **Meta Graph API** | Facebook Pages, Messenger Send API, WhatsApp Cloud API |
| **Optional: Wkil scraper** | `SCRAPING_SERVICE_URL` |
| **Optional: ML sentiment service** | Code exists in `src/routes/sentiment.routes.ts` — **not mounted** in `app.ts` today; mention only as roadmap or wire-up task |

---

## 6. Data model highlights (for “what we store” / trust center)

- Users, roles, manager assignments, soft delete / deactivate.
- Business profiles, FAQs, **vector chunks**.
- Facebook accounts, pages, **activity** audit trail.
- WhatsApp accounts linked to users and optionally business profiles.
- **Conversations** unified for Messenger + WhatsApp (`channel`, `customerPhone` for WA).
- **Messages** with roles `user` | `model`.
- CRM integrations and external data sources **per business profile**.
- **ProcessedMessengerMessage** / **ProcessedWhatsAppMessage** for webhook idempotency.
- **Lead** capture records.

---

## 7. Gaps / honest footnotes (avoid over-claiming)

- **`/v1/users`:** router mounted but **no active routes** (commented `me`); primary user self route is **`/v1/auth/me`**.
- **Sentiment API file** exists but is **not registered** on the Express app unless you add it.
- **Lead GET** may need **auth hardening** before public marketing as “secure admin-only.”
- **WhatsApp “mark read” PATCH** is explicitly a **stub** until a `readAt` column exists.

---

## 8. Suggested marketing taglines by audience

- **SMB owner:** “Turn your website and business profile into an AI assistant that answers on WhatsApp and Messenger — and posts to Facebook in your brand voice.”
- **Agency:** “Multi-tenant roles, per-client business brains, and Meta channels with CRM handoff — one API.”
- **Enterprise:** “RAG-grounded replies, encrypted tokens, webhook verification, rate limits, and code-level truthfulness gates on AI actions.”

---

## 9. File map (for internal teams)

| Area | Main locations |
|------|----------------|
| Routes | `src/routes/**`, `src/app.ts` |
| Meta | `src/services/meta/*`, `src/routes/meta/*`, `src/queues/*` |
| AI / RAG | `src/services/ai/aiEngine.service.ts`, `src/rag/*`, `src/services/meta/prompt.service.ts` |
| CRM / external APIs | `src/routes/crm.routes.ts`, `src/routes/externalDataSource.routes.ts`, `src/services/crm/*`, `src/services/external/*` |
| Content | `src/routes/content.routes.ts`, `src/services/content.service.ts` |
| Auth / roles | `src/middlewares/auth.middleware.ts`, `src/middlewares/roleValidation.middleware.ts` |
| Schema | `prisma/schema.prisma` |

---

*Generated from repository scan. Update this file when you ship new routes or change behavior.*

