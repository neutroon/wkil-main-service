# Mobile confirmation delivery

The existing mobile Socket.IO namespace authenticates with `auth.token`, a backend
access JWT. Business and conversation room authorization uses the same accessible-profile
policy as the REST order and inbox APIs, including active workspace membership.

`order_confirmation_updated` carries `{ businessProfileId, orderId }` to the authorized
business room in both the dashboard and mobile namespaces. It is an invalidation signal:
clients refetch their authorized order list/detail, rather than treating the event as a
complete order record. Creation, applied customer actions, notification delivery/retry
state, and store synchronization updates invalidate the affected order. A reconnect or
foreground transition should refetch because sockets do not replay missed events.

Applied `CONFIRMED`/`CANCELED` customer actions send best-effort FCM alerts with data
`{ type: "order_confirmation", order_id, business_id, status }` and Android channel
`order_confirmations`. Newly persisted human-handoff audit messages send the existing
`handoff_request` payload and channel `handoff_requests_v2`. Retried/replayed actions
do not send a second alert. Socket/FCM failures must not change committed business results.

Push recipients are active devices for the business owner and active workspace members,
limited to active user accounts. Dead FCM tokens are removed. Notification bodies are
generic and Android lock-screen visibility is private; no customer message text is put
in the operating-system preview. Device tokens and provider credentials are never logged.

The mobile application uses the existing authenticated POST/DELETE
`/v1/notifications/device-tokens` contract. Android must register native FCM tokens, not
Expo Push Tokens. Its Firebase Android client configuration must match the backend FCM
project. No new HTTP endpoint or database migration is introduced. This backend does not
convert raw Apple APNs tokens into FCM tokens; iOS needs a separate native FCM registration
integration before remote delivery can be enabled there.

Verify configured delivery on a native Android build for permission denial/grant,
foreground/background/terminated state, duplicate action replay, active membership,
revoked membership, sign-out, token rotation, and notification taps. Unit tests exercise
scope and idempotency boundaries; they do not contact production providers or databases.

## Deployment checks

Deploy the backend from this repository to the existing `wkil-main-service` Fly app.
The Docker build context excludes local environment files, Google credential files,
private keys, logs, and development checkouts. Provider credentials must come from
the app's existing private runtime configuration, rather than the image.

Before deployment, verify that the live FCM sender is enabled, its credential project
matches the Android client configuration, and excluding local credentials preserves
the existing Google application credential setup. Inspect booleans and secret names
only; do not print credentials or customer data.

The October 8, 2026 audit confirmed that the live Firebase sender matches the
supplied Android project's Firebase project and can acquire a token with FCM send
permission. No test notification was sent. The legacy `google-cloud-key.json`
is excluded from the new image: `vertexai.config.ts` has no active imports, current
image generation uses the configured Gemini API key, and FCM materializes its
credential from the existing Fly secret. Reintroducing Vertex calls requires a
separate secure credential setup with the appropriate project permissions.

This confirmation delivery change has no Prisma schema or migration changes. A
code-only deployment can use `--skip-release-command` after checking that fact to
avoid applying unrelated migrations through the existing Fly release command.
Verify the resulting release, running machines, and `/v1/ready` afterward. Service
readiness alone does not prove remote notification delivery; complete a test-device
delivery check separately.
