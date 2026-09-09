# Server-generated Copilot thread titles

## Goal

Make the server the single authority for deterministic Copilot conversation titles. Web and React Native must display the title returned in LangGraph thread metadata and must not derive an automatic title from messages.

## Architecture

The authenticated backend assistant gateway owns automatic title creation because it receives the first human message and already proxies the authenticated LangGraph thread operations. On a new, non-resume run it will:

1. Derive a title from the first message's text by collapsing whitespace and truncating at a word boundary with the existing 48-character limit.
2. Read the thread metadata and persisted state through the trusted LangGraph service.
3. Choose the earliest human message from persisted state, falling back to the current first human message when the state is empty.
4. Update metadata only when no valid title exists, preserving manual renames and titles created by another client.
5. Forward the run to the agent service.

The existing gateway metadata validation will accept string titles and will continue to stamp the authenticated workspace. Automatic title failures remain non-fatal to chat execution; the server logs the failure and the run continues.

## Client contract

Both clients continue using the shared `RemoteThreadListAdapter`:

- `list()` maps `metadata.title` to the assistant-ui thread item.
- `rename()` sends an explicit user rename to the server.
- `generateTitle()` no longer examines messages. It reads the server thread metadata and returns the stored title only to update assistant-ui's local list state immediately.

The web client keeps its existing rename UI. React Native remains display-only until a rename control is intentionally added.

## Error handling and security

The gateway derives the title only from its normalized authenticated run input and only operates on the current user/workspace-scoped thread. Resume commands never trigger automatic title creation. The gateway never accepts client-supplied automatic titles; explicit rename requests remain length-validated and workspace-stamped. A missing or failed metadata update cannot break the assistant run.

## Testing

Add tests that prove:

- String titles survive gateway normalization for create and update.
- A first user run causes the server to read and set a title, while a titled thread is not overwritten.
- Resume runs and image-only messages do not create an automatic title.
- Web and React Native title adapters read server metadata and do not generate titles from passed messages.
- Existing thread-list rendering and rename behavior remain intact.
