import { describe, it, expect, vi } from "vitest";
import { getSuggestionsController, getUx2FlagController } from "./copilot.suggestions.controller";
import { getCopilotSuggestions, isUx2Enabled } from "./copilot.suggestions.service";

vi.mock("./copilot.suggestions.service", () => ({
  getCopilotSuggestions: vi.fn(),
  isUx2Enabled: vi.fn(() => true),
}));

const mkRes = () => {
  const res: any = {};
  res.status = (c: number) => { res._status = c; return res; };
  res.json = (b: any) => { res._body = b; return res; };
  return res;
};

describe("suggestions controller", () => {
  it("calls service with parsed query and returns data", async () => {
    (getCopilotSuggestions as any).mockResolvedValue({ prompts: [{ text: "x" }], source: "llm" });
    const req: any = { user: { id: 9 }, query: { locale: "en", conversationKind: "GENERAL", hour: "8", recentTitles: "A,B" } };
    const res = mkRes();
    await getSuggestionsController(req, res);
    expect(getCopilotSuggestions).toHaveBeenCalledWith({ userId: 9, locale: "en", conversationKind: "GENERAL", hour: 8, recentTitles: ["A", "B"] });
    expect(res._status).toBe(200);
    expect(res._body.data.source).toBe("llm");
  });

  it("ux2 flag endpoint returns enabled", async () => {
    const res = mkRes();
    await getUx2FlagController({} as any, res);
    expect(res._body.data.enabled).toBe(true);
  });
});
