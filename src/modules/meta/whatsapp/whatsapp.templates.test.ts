import { afterEach, describe, expect, it, vi } from "vitest";
vi.mock("@utils/logger", () => ({ logger: { error: vi.fn(), warn: vi.fn() } }));
import { listWhatsAppTemplates } from "./whatsapp.service";

afterEach(() => vi.unstubAllGlobals());
describe("WhatsApp template listing", () => {
  it("includes a pinned template on the second approved-template page", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce({ ok: true, json: async () => ({ data: [{ id: "1001" }], paging: { next: "https://graph.facebook.com/v25.0/123/message_templates?status=APPROVED&after=cursor2&access_token=fixture-token" } }) })
      .mockResolvedValueOnce({ ok: true, json: async () => ({ data: [{ id: "1002" }] }) });
    vi.stubGlobal("fetch", fetchMock);
    expect(await listWhatsAppTemplates("123", "fixture-token")).toEqual([{ id: "1001" }, { id: "1002" }]);
    const secondUrl = new URL(String(fetchMock.mock.calls[1][0]));
    expect(secondUrl.origin).toBe("https://graph.facebook.com");
    expect(secondUrl.pathname).toBe("/v25.0/123/message_templates");
    expect(secondUrl.searchParams.get("after")).toBe("cursor2");
    expect(secondUrl.searchParams.has("access_token")).toBe(false);
  });
  it("never follows a pagination link outside the authorized account", async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ data: [], paging: { next: "https://graph.facebook.com/v25.0/999/message_templates?after=cursor2" } }) });
    vi.stubGlobal("fetch", fetchMock);
    await expect(listWhatsAppTemplates("123", "fixture-token")).rejects.toMatchObject({ code: "WHATSAPP_TEMPLATE_LIST_INVALID" });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
  it("keeps send-time lookups narrowed to the configured template name", async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ data: [] }) });
    vi.stubGlobal("fetch", fetchMock);
    await listWhatsAppTemplates("123", "fixture-token", { name: "order_confirm" });
    expect(new URL(String(fetchMock.mock.calls[0][0])).searchParams.get("name")).toBe("order_confirm");
  });
  it("rejects repeated cursors instead of looping indefinitely", async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ data: [], paging: { next: "https://graph.facebook.com/v25.0/123/message_templates?after=cursor2" } }) });
    vi.stubGlobal("fetch", fetchMock);
    await expect(listWhatsAppTemplates("123", "fixture-token")).rejects.toMatchObject({ code: "WHATSAPP_TEMPLATE_LIST_INVALID" });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
  it("fails the whole lookup when a later page fails", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce({ ok: true, json: async () => ({ data: [{ id: "1001" }], paging: { next: "https://graph.facebook.com/v25.0/123/message_templates?after=cursor2" } }) })
      .mockResolvedValueOnce({ ok: false, status: 503 });
    vi.stubGlobal("fetch", fetchMock);
    await expect(listWhatsAppTemplates("123", "fixture-token")).rejects.toMatchObject({ code: "WHATSAPP_TEMPLATE_LIST_FAILED" });
  });
});
