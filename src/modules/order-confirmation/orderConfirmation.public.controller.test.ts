import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import http from "http";
import express, { type Application } from "express";

const mocks = vi.hoisted(() => ({
  findActiveIntegrationByPublicKey: vi.fn(),
  insertOrderEventIfNew: vi.fn(),
  enqueueOrderEvent: vi.fn(),
  loggerError: vi.fn(),
  decryptFacebookSecret: vi.fn(),
}));

vi.mock("./orderConfirmation.repository", () => ({
  findActiveIntegrationByPublicKey: mocks.findActiveIntegrationByPublicKey,
  insertOrderEventIfNew: mocks.insertOrderEventIfNew,
}));

vi.mock("./orderConfirmation.queue", () => ({
  enqueueOrderEvent: mocks.enqueueOrderEvent,
}));

vi.mock("@modules/auth/core/tokenCrypto", () => ({
  decryptFacebookSecret: mocks.decryptFacebookSecret,
}));

vi.mock("@utils/logger", () => ({
  logger: {
    error: mocks.loggerError,
  },
}));

import { computeOrderWebhookSignature } from "./orderConfirmation.crypto";
import orderConfirmationPublicRoutes from "./orderConfirmation.public.routes";

function makeApp(): Application {
  const app = express();
  app.use(express.raw({ type: "application/json", limit: "256kb" }));
  app.use(orderConfirmationPublicRoutes);
  return app;
}

function doRequest(
  server: http.Server,
  opts: {
    method: string;
    path: string;
    headers?: Record<string, string>;
    body?: Buffer;
  },
): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const address = server.address() as { port: number };
    const payload = opts.body ?? Buffer.alloc(0);
    const request = http.request(
      {
        hostname: "127.0.0.1",
        port: address.port,
        path: opts.path,
        method: opts.method,
        headers: {
          "content-type": "application/json",
          "content-length": String(payload.length),
          ...opts.headers,
        },
      },
      (response) => {
        const chunks: Buffer[] = [];
        response.on("data", (chunk: Buffer) => chunks.push(chunk));
        response.on("end", () =>
          resolve({
            status: response.statusCode ?? 0,
            body: Buffer.concat(chunks).toString("utf8"),
          }),
        );
      },
    );
    request.on("error", reject);
    if (payload.length > 0) request.write(payload);
    request.end();
  });
}

const event = {
  schemaVersion: "1",
  eventId: "evt_123",
  eventType: "order.created",
  occurredAt: "2026-08-13T10:30:00.000Z",
  order: {
    id: "ord_123",
    number: "#123",
    currency: "USD",
    total: "10.00",
    customer: { phone: "+12025550123" },
  },
};

const integration = {
  id: 7,
  businessProfileId: 11,
  signingSecret: "webhook-secret",
  previousSigningSecret: "previous-webhook-secret",
  isActive: true,
};

function signedRequest(
  secretOrBody: string | Buffer = integration.signingSecret,
  body = Buffer.from(JSON.stringify(event), "utf8"),
) {
  const secret = Buffer.isBuffer(secretOrBody) ? integration.signingSecret : secretOrBody;
  const rawBody = Buffer.isBuffer(secretOrBody) ? secretOrBody : body;
  const timestamp = String(Math.floor(Date.now() / 1000));
  return {
    body: rawBody,
    headers: {
      "idempotency-key": event.eventId,
      "x-wkil-timestamp": timestamp,
      "x-wkil-signature": computeOrderWebhookSignature(timestamp, rawBody, secret),
    },
  };
}

describe("POST /:integrationKey/events", () => {
  let server: http.Server;

  beforeEach(async () => {
    vi.clearAllMocks();
    mocks.decryptFacebookSecret.mockImplementation((value: string) => value);
    mocks.findActiveIntegrationByPublicKey.mockResolvedValue(integration);
    mocks.insertOrderEventIfNew.mockResolvedValue({
      duplicate: false,
      event: { id: 101 },
    });
    mocks.enqueueOrderEvent.mockResolvedValue(undefined);
    server = http.createServer(makeApp());
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });
  });

  afterEach(
    () =>
      new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      }),
  );

  it("accepts a valid signed raw event after persistence", async () => {
    const request = signedRequest(Buffer.from(JSON.stringify(event, null, 2), "utf8"));
    const response = await doRequest(server, {
      method: "POST",
      path: "/public-key/events",
      ...request,
    });

    expect(response.status).toBe(202);
    expect(JSON.parse(response.body)).toEqual({
      accepted: true,
      duplicate: false,
      eventId: "evt_123",
    });
    expect(mocks.insertOrderEventIfNew).toHaveBeenCalledWith(
      expect.objectContaining({
        integrationId: 7,
        businessProfileId: 11,
        externalEventId: "evt_123",
        rawPayload: event,
      }),
    );
    expect(mocks.enqueueOrderEvent).toHaveBeenCalledWith(101, expect.any(String));
  });

  it("returns 401 and does not persist an invalid signature", async () => {
    const request = signedRequest();
    request.headers["x-wkil-signature"] = "v1=" + "0".repeat(64);

    const response = await doRequest(server, {
      method: "POST",
      path: "/public-key/events",
      ...request,
    });

    expect(response.status).toBe(401);
    expect(mocks.insertOrderEventIfNew).not.toHaveBeenCalled();
  });

  it("accepts the previous signing secret during rotation overlap", async () => {
    const response = await doRequest(server, {
      method: "POST",
      path: "/public-key/events",
      ...signedRequest(integration.previousSigningSecret),
    });

    expect(response.status).toBe(202);
    expect(mocks.insertOrderEventIfNew).toHaveBeenCalledTimes(1);
    expect(mocks.decryptFacebookSecret).toHaveBeenNthCalledWith(1, integration.signingSecret);
    expect(mocks.decryptFacebookSecret).toHaveBeenNthCalledWith(
      2,
      integration.previousSigningSecret,
    );
  });

  it("returns 500 when the previous signing secret cannot be decrypted", async () => {
    mocks.decryptFacebookSecret.mockImplementation((value: string) => {
      if (value === integration.previousSigningSecret) throw new Error("invalid previous secret");
      return value;
    });

    const response = await doRequest(server, {
      method: "POST",
      path: "/public-key/events",
      ...signedRequest(),
    });

    expect(response.status).toBe(500);
    expect(mocks.insertOrderEventIfNew).not.toHaveBeenCalled();
    expect(JSON.stringify(mocks.loggerError.mock.calls)).not.toContain(
      integration.previousSigningSecret,
    );
  });

  it("returns 500 when the integration secret cannot be decrypted", async () => {
    mocks.decryptFacebookSecret.mockImplementation(() => {
      throw new Error("encryption key unavailable");
    });

    const response = await doRequest(server, {
      method: "POST",
      path: "/public-key/events",
      ...signedRequest(),
    });

    expect(response.status).toBe(500);
    expect(mocks.insertOrderEventIfNew).not.toHaveBeenCalled();
    expect(mocks.loggerError).toHaveBeenCalledWith(
      "order_confirmation.webhook.secret_unavailable",
      expect.objectContaining({
        correlationId: expect.any(String),
        eventId: "evt_123",
        integrationId: 7,
      }),
    );
    expect(JSON.stringify(mocks.loggerError.mock.calls)).not.toContain(
      integration.signingSecret,
    );
  });

  it("returns 400 when Idempotency-Key is missing or mismatched", async () => {
    const request = signedRequest();
    Reflect.deleteProperty(request.headers, "idempotency-key");

    const missing = await doRequest(server, {
      method: "POST",
      path: "/public-key/events",
      ...request,
    });
    expect(missing.status).toBe(400);

    const mismatched = await doRequest(server, {
      method: "POST",
      path: "/public-key/events",
      ...signedRequest(),
      headers: {
        ...signedRequest().headers,
        "idempotency-key": "evt_other",
      },
    });
    expect(mismatched.status).toBe(400);
    expect(mocks.findActiveIntegrationByPublicKey).not.toHaveBeenCalled();
  });

  it("returns 400 for malformed JSON", async () => {
    const body = Buffer.from("{not-json", "utf8");
    const timestamp = String(Math.floor(Date.now() / 1000));

    const response = await doRequest(server, {
      method: "POST",
      path: "/public-key/events",
      body,
      headers: {
        "idempotency-key": "evt_123",
        "x-wkil-timestamp": timestamp,
        "x-wkil-signature": computeOrderWebhookSignature(timestamp, body, integration.signingSecret),
      },
    });

    expect(response.status).toBe(400);
    expect(mocks.findActiveIntegrationByPublicKey).not.toHaveBeenCalled();
  });

  it("returns 404 for an unknown or inactive integration", async () => {
    mocks.findActiveIntegrationByPublicKey.mockResolvedValue(null);
    const response = await doRequest(server, {
      method: "POST",
      path: "/unknown/events",
      ...signedRequest(),
    });

    expect(response.status).toBe(404);
    expect(mocks.insertOrderEventIfNew).not.toHaveBeenCalled();
  });

  it("returns 404 for an inactive integration", async () => {
    mocks.findActiveIntegrationByPublicKey.mockResolvedValue({
      ...integration,
      isActive: false,
    });
    const response = await doRequest(server, {
      method: "POST",
      path: "/inactive/events",
      ...signedRequest(),
    });

    expect(response.status).toBe(404);
    expect(mocks.insertOrderEventIfNew).not.toHaveBeenCalled();
  });

  it("returns 202 for a duplicate event without enqueueing it again", async () => {
    mocks.insertOrderEventIfNew.mockResolvedValue({ duplicate: true });
    const response = await doRequest(server, {
      method: "POST",
      path: "/public-key/events",
      ...signedRequest(),
    });

    expect(response.status).toBe(202);
    expect(JSON.parse(response.body)).toMatchObject({ accepted: true, duplicate: true });
    expect(mocks.enqueueOrderEvent).not.toHaveBeenCalled();
  });

  it("returns 202 and leaves a persisted event recoverable when enqueue fails", async () => {
    mocks.enqueueOrderEvent.mockRejectedValue(new Error("queue unavailable"));
    const response = await doRequest(server, {
      method: "POST",
      path: "/public-key/events",
      ...signedRequest(),
    });

    expect(response.status).toBe(202);
    expect(JSON.parse(response.body)).toMatchObject({ accepted: true, duplicate: false });
    expect(mocks.loggerError).toHaveBeenCalledWith(
      "order_confirmation.webhook.enqueue_failed",
      expect.objectContaining({ correlationId: expect.any(String), eventId: "evt_123" }),
    );
  });

  it("returns 500 when event persistence fails", async () => {
    mocks.insertOrderEventIfNew.mockRejectedValue(new Error("database unavailable"));
    const response = await doRequest(server, {
      method: "POST",
      path: "/public-key/events",
      ...signedRequest(),
    });

    expect(response.status).toBe(500);
    expect(mocks.enqueueOrderEvent).not.toHaveBeenCalled();
  });
});
