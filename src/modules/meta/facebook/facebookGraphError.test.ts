import axios from "axios";
import { describe, expect, it } from "vitest";
import { mapFacebookGraphError } from "./facebookGraphError";

describe("mapFacebookGraphError", () => {
  it("maps Graph error payload from Axios error", () => {
    const err = new axios.AxiosError("Request failed");
    err.response = {
      status: 400,
      data: {
        error: { message: "Invalid OAuth access token.", code: 190 },
      },
    } as any;

    const m = mapFacebookGraphError(err);
    expect(m.message).toContain("Invalid OAuth");
    expect(m.code).toBe(190);
    expect(m.status).toBe(400);
  });

  it("maps generic Error", () => {
    expect(mapFacebookGraphError(new Error("oops")).message).toBe("oops");
  });
});


