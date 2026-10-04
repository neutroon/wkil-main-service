# Order confirmation template identity

Meta's template record ID is the primary identity for order-confirmation
templates. `OrderTemplateConfig.id` remains our numeric configuration ID;
`metaTemplateId` is the separate provider ID, stored as a string. Name and
language are retained because Meta's message-send request requires them.

## Saving and loading

- The UI uses the provider ID for keys, selection, dirty state, validation
  ownership, configuration loading, and save matching.
- The backend resolves an ID against approved templates fetched for the
  integration's authorized WhatsApp account. IDs never bypass tenant/account
  ownership checks. Saved name/language come from that provider record.
- New saves require a provider record with an ID. An unknown or unapproved ID
  is rejected, even when another template has the same name and language.
- An update without a new ID retains the pinned ID. A legacy client explicitly
  changing name/language resolves a new target; re-sending unchanged metadata
  does not unpin an existing record.
- Copilot's existing name/language inputs remain compatible, but its saves
  also persist the resolved ID and its updates respect existing pins.
- Before sending a pinned template, the worker verifies its ID, approval,
  name, and language against the account's current provider templates. A
  missing, recreated, or mismatched record fails with
  `ORDER_TEMPLATE_ID_UNAVAILABLE` before acquiring a send permit or sending.
  A transient provider lookup failure follows the existing worker retry policy.
- Approved-template listing follows all pages within the authorized WABA;
  send-time verification filters by the stored name and then checks the exact
  ID. Pagination cannot change the account or carry tokens in the request URL.

## Existing configurations and rollout

Migration `20261004060000_order_template_meta_id` only adds a nullable TEXT
column. It does not delete data or guess provider IDs from local names.

1. Apply the additive migration before running the new backend. The existing
   backend can continue to run with the new column.
2. Deploy the backend and its OpenAPI contract before deploying the updated
   frontend, since the previous strict request schema rejects `metaTemplateId`.
3. Existing null-ID rows load by name/language within the selected account.
   Their next successful save/revalidation persists the resolved provider ID.
   Older name/language clients gain IDs through the same server resolution.
4. Existing null-ID notification configurations keep their previous sending
   behavior until saved; pinned rows use the additional provider identity check.
5. If a pinned template was deleted/recreated, explicitly select and save the
   replacement. Never clear its pin automatically or silently select by name.

The frontend retains a name/language fallback for older API responses without
template IDs. Configuration matching never uses that fallback when a saved
`metaTemplateId` exists. Multiple configurations can reference the same
provider template for different locales/events, so the provider ID is not a
unique key for configuration rows.

After rollback, keep the additive column and its data; older backend code
ignores it. No down migration is required to roll back application code.
