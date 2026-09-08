import { beforeEach, describe, expect, it, vi } from "vitest";

const socketMocks = vi.hoisted(() => ({
  emitToBusiness: vi.fn(),
  emitToConversation: vi.fn(),
}));

vi.mock("./socket", () => ({
  emitToBusiness: socketMocks.emitToBusiness,
  emitToConversation: socketMocks.emitToConversation,
}));

vi.mock("@utils/logger", () => ({
  logger: {
    debug: vi.fn(),
    warn: vi.fn(),
  },
}));

import { syncCoexistenceHistoryImported } from "./socketSync.service";

describe("Coexistence import realtime synchronization", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("emits one business-room event with the stable bulk import payload", () => {
    const input = {
      businessProfileId: 42,
      phoneNumberId: "phone-number-id",
      conversationIds: [101, 202],
      importedMessageCount: 3,
      importedContactCount: 0,
    };

    syncCoexistenceHistoryImported(input);

    expect(socketMocks.emitToBusiness).toHaveBeenCalledTimes(1);
    expect(socketMocks.emitToBusiness).toHaveBeenCalledWith(
      42,
      "whatsapp_history_imported",
      input,
    );
    expect(socketMocks.emitToConversation).not.toHaveBeenCalled();
  });
});
