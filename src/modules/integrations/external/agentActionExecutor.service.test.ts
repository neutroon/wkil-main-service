import { describe, expect, it } from "vitest";
import {
  assertExternalArgsAllowedByPolicy,
  assertExternalApiUrlLooksSafe,
  buildServerInjectedParams,
  filterExternalArgsBySchema,
  maskExternalHeaders,
  mergeHeaderUpdate,
  toCanonicalVerificationRead,
  toCanonicalVerificationMutation,
} from "./agentActionExecutor.service";
import { updateAgentActionSourceSchema } from "./agentAction.validation";

describe("toCanonicalVerificationRead", () => {
  it("marks non-empty JSON without explicit status as verified (data returned)", () => {
    const data = {
      id: "order_123",
      customer: "Hesham",
      program: "الدعم النفسى بالفنون",
    };
    expect(toCanonicalVerificationRead(data)).toEqual({
      verification: "verified",
      reason: "data_returned",
    });
  });

  it("treats empty object as failed (no data)", () => {
    expect(toCanonicalVerificationRead({})).toEqual({
      verification: "failed",
      reason: "no_data_found",
    });
  });

  it("treats provider success false as failed", () => {
    expect(toCanonicalVerificationRead({ success: false, message: "nope" })).toEqual({
      verification: "failed",
      reason: "provider_success_false",
    });
  });

  it("treats explicit error status as failed", () => {
    expect(toCanonicalVerificationRead({ status: "error" })).toEqual({
      verification: "failed",
      reason: "provider_status_error",
    });
  });

  it("exposes only AI-writable params and injects server-owned params", () => {
    const schema = {
      orderId: {
        type: "STRING",
        source: "USER_PROVIDED",
        description: "Order ID from the customer",
      },
      date: {
        type: "STRING",
        source: "AI_DERIVED",
        description: "ISO date derived from the customer request",
      },
      phone: {
        type: "STRING",
        source: "CHAT_CONTEXT",
        contextKey: "customerPhone",
        description: "Phone from chat context",
      },
      source: {
        type: "STRING",
        source: "DEFAULT",
        value: "PagesPilot AI",
        description: "Default source label",
      },
      tenant: {
        type: "FIXED",
        value: "tenant_1",
        description: "Fixed tenant scope",
      },
    };

    expect(
      filterExternalArgsBySchema(schema, {
        orderId: "A-1",
        date: "2026-05-09",
        phone: "+201000000000",
        source: "evil",
        tenant: "evil",
      }),
    ).toEqual({ orderId: "A-1", date: "2026-05-09" });

    expect(
      buildServerInjectedParams(schema, {
        customerPhone: "+201234567890",
      }, { source: "Campaign A" }),
    ).toEqual({
      phone: "+201234567890",
      tenant: "tenant_1",
    });

    expect(
      buildServerInjectedParams(schema, {
        customerPhone: "+201234567890",
      }),
    ).toMatchObject({
      source: "PagesPilot AI",
    });
  });

  it("strips nested server-owned fields from model args and injects them from action results", () => {
    const schema = {
      selectedProgram: {
        type: "OBJECT",
        source: "USER_PROVIDED",
        description: "Program selected by the customer",
        properties: {
          name: {
            type: "STRING",
            source: "USER_PROVIDED",
            description: "Program name from the customer",
          },
          courseId: {
            type: "STRING",
            source: "ACTION_RESULT",
            path: "data.data.courses.0.id",
            description: "Program id returned by the lookup action",
          },
        },
      },
    };

    expect(
      filterExternalArgsBySchema(schema, {
        selectedProgram: {
          name: "الدعم النفسى بالفنون",
          courseId: "invented-id",
        },
      }),
    ).toEqual({
      selectedProgram: {
        name: "الدعم النفسى بالفنون",
      },
    });

    expect(
      buildServerInjectedParams(
        schema,
        {
          parentActionResponse: {
            data: {
              data: {
                courses: [{ id: "course-123" }],
              },
            },
          },
        },
        {
          selectedProgram: {
            name: "الدعم النفسى بالفنون",
          },
        },
      ),
    ).toEqual({
      selectedProgram: {
        courseId: "course-123",
      },
    });
  });

  it("blocks USER_PROVIDED params invented by the model while allowing AI_DERIVED fields", () => {
    const schema = {
      propertyName: {
        type: "STRING",
        source: "USER_PROVIDED",
        description: "Lookup value supplied by the customer",
      },
      date: {
        type: "STRING",
        source: "AI_DERIVED",
        description: "ISO date derived from the customer request",
      },
    };

    expect(
      assertExternalArgsAllowedByPolicy(
        schema,
        { propertyName: "pagesPilot services" },
        { latestUserText: "fd" },
      ),
    ).toEqual({
      ok: false,
      field: "propertyName",
      reason: "unprovided_parameter:propertyName",
    });

    expect(
      assertExternalArgsAllowedByPolicy(
        schema,
        { propertyName: "order A-1", date: "2026-05-09" },
        { latestUserText: "check order A-1 tomorrow" },
      ),
    ).toEqual({ ok: true });

    expect(
      assertExternalArgsAllowedByPolicy(
        schema,
        { propertyName: "+201001112222" },
        { latestUserText: "رقمي +20 100 111 2222" },
      ),
    ).toEqual({ ok: true });
  });
});

describe("toCanonicalVerificationMutation", () => {
  it("marks successful mutation responses as verified", () => {
    expect(toCanonicalVerificationMutation({ id: "booking_123" }, true)).toEqual({
      verification: "verified",
      reason: "http_success",
    });
  });

  it("marks empty 2xx mutation responses as verified", () => {
    expect(toCanonicalVerificationMutation(null, true)).toEqual({
      verification: "verified",
      reason: "http_success",
    });
  });

  it("treats provider success false as failed", () => {
    expect(
      toCanonicalVerificationMutation({ success: false, message: "rejected" }, true),
    ).toEqual({
      verification: "failed",
      reason: "provider_success_false",
    });
  });

  it("treats failed HTTP mutation responses as failed", () => {
    expect(toCanonicalVerificationMutation({ error: "bad request" }, false)).toEqual({
      verification: "failed",
      reason: "http_failed",
    });
  });
});

describe("Agent Action production hardening helpers", () => {
  it("treats null query params as an empty config object on update", () => {
    const result = updateAgentActionSourceSchema.parse({
      params: { profileId: 1, sourceId: 2 },
      body: {
        queryParams: null,
      },
    });

    expect(result.body.queryParams).toEqual({});
  });

  it("rejects localhost and private IP URLs", () => {
    expect(() => assertExternalApiUrlLooksSafe("http://localhost:3000/data")).toThrow();
    expect(() => assertExternalApiUrlLooksSafe("http://127.0.0.1/data")).toThrow();
    expect(() => assertExternalApiUrlLooksSafe("http://10.0.0.2/data")).toThrow();
    expect(() => assertExternalApiUrlLooksSafe("https://api.example.com/data")).not.toThrow();
  });

  it("masks headers before sending sources back to the browser", () => {
    expect(maskExternalHeaders({ Authorization: "Bearer secret" })).toEqual({
      Authorization: "********",
    });
  });

  it("preserves existing encrypted headers when the update payload sends a mask", () => {
    const merged = mergeHeaderUpdate(
      { Authorization: "enc:v1:stored-secret" },
      { Authorization: "********", "X-Mode": "live" },
    );

    expect(merged).toEqual({
      Authorization: "enc:v1:stored-secret",
      "X-Mode": expect.any(String),
    });
  });

  it("drops model args when a chat-requested action declares no params", () => {
    expect(filterExternalArgsBySchema(undefined, { q: "invented", id: "123" })).toEqual({});
    expect(filterExternalArgsBySchema({}, { q: "invented", id: "123" })).toEqual({});
  });

  it("allows only model args declared by the expected param schema", () => {
    expect(
      filterExternalArgsBySchema(
        { orderId: "Order identifier", email: "Customer email" },
        { orderId: "A-1", email: "x@example.com", q: "extra" },
      ),
    ).toEqual({
      orderId: "A-1",
      email: "x@example.com",
    });
  });
});

