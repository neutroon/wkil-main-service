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

