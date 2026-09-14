# WKIL Backend Agent Guide

## Scope and Stack

This repository contains the Node.js backend. It uses Node 24, Express, TypeScript, Prisma, PostgreSQL, Redis and BullMQ, OpenAPI, Socket.IO, and external service integrations.

## Setup and Commands

- Use npm and preserve `package-lock.json`. Do not introduce a pnpm or Yarn lockfile.
- Use a Node version allowed by the `engines` field in `package.json`.
- Install reproducibly with `npm ci`; use `npm install` only when intentionally updating dependencies and the lockfile.
- Start development with `npm run dev`.
- Run focused tests with `npm test -- <path-or-pattern>` when possible, then the full suite with `npm test` when warranted.
- Run the production compile and OpenAPI bundle with `npm run build`.
- Validate API documentation with `npm run docs:check` when routes, schemas, or response behavior change.

## Architecture and API Contracts

- Keep HTTP transport, validation, business logic, persistence, queues, and third-party adapters in their existing layers. Avoid embedding business rules directly in route handlers.
- Validate request parameters, bodies, uploaded files, webhook payloads, and external responses at their trust boundaries.
- Keep error responses stable and intentional. Do not expose stack traces, provider payloads, SQL details, secrets, or internal identifiers.
- Treat `docs/openapi.yaml` as the public HTTP contract. Update it with behavior changes and keep route coverage checks passing.
- `npm run types:api` writes the generated client into `../app/`. Run it only when a coordinated web-client update is intended, and never hand-edit that generated file.

## Mandatory Skills and MCP Routing

- Follow the workspace `Required Capability Routing and No Silent Skips` policy. Announce applicable skills and MCPs before substantive work, and disclose any unavailable capability with the fallback used.
- Use every directly applicable capability listed below. If one is intentionally not used, explain why before continuing; never omit it silently.
- For any LangChain or LangGraph task, use `ecosystem-primer` first. Then read every directly applicable skill, including `langchain-dependencies`, `langchain-fundamentals`, `langchain-middleware`, `langchain-rag`, `langgraph-fundamentals`, `langgraph-human-in-the-loop`, `langgraph-persistence`, or `langgraph-cli` as the task requires.
- Search the LangChain documentation MCP and read the exact relevant documentation before implementation. Use the LangChain API-reference MCP for exact TypeScript packages, symbols, signatures, and version-sensitive behavior.
- Use Deep Agents skills only when the task actually involves a Deep Agents application; when it does, follow their stated prerequisite and routing requirements rather than silently treating generic LangChain guidance as sufficient.
- If an applicable LangChain documentation or reference MCP is unavailable, disclose that and fall back to installed package types/source plus current official LangChain documentation.

### Reproducing Codex Capabilities

- Install the LangChain ecosystem skills with `npx skills add langchain-ai/langchain-skills --skill '*' --yes` when they are absent.
- Register both official documentation servers with `codex mcp add langchain-docs --url https://docs.langchain.com/mcp` and `codex mcp add langchain-reference --url https://reference.langchain.com/mcp`.
- Verify from the same user profile that launches Codex with `codex mcp list`, start a new task to refresh the tool inventory, and smoke-test both a conceptual documentation search and an exact TypeScript symbol lookup.
- These public documentation servers require no repository credentials. Never commit tokens or private MCP configuration.

## Database and Jobs

- Use Prisma migrations for schema changes. Review generated SQL before applying it and include the migration with the schema change.
- Never use destructive resets, force migrations, production migration commands, or manual data deletion without explicit approval and a verified target environment.
- Preserve transaction boundaries and tenant filters. Consider concurrency, idempotency, retries, and partial failure for queues, webhooks, and external side effects.
- Keep expensive or unreliable external work out of request-critical paths where the existing queue architecture supports asynchronous execution.

## Authentication and Security

- Enforce authentication, authorization, resource ownership, and tenant isolation in server-side policy or service boundaries.
- Use least privilege for database, storage, email, AI, and cloud integrations. Never read, print, commit, or modify real credential values as part of ordinary development.
- Apply bounded input sizes, rate limits, safe file handling, timeouts, cancellation, and redaction where relevant.
- Verify webhook signatures before processing and make repeated delivery safe.

## Definition of Done

- Add regression tests for behavior changes and test both success and important failure paths.
- Run focused tests during development, then `npm test` and `npm run build` for code changes. Also run `npm run docs:check` for API contract changes and check migration status for Prisma changes.
- Inspect the final diff for secrets, unsafe logging, missing authorization, undocumented API drift, generated build output, and unrelated edits.
