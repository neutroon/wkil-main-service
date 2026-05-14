import type { AiRoutingDecision } from "@modules/ai-agent/core/aiEngine.utils";

export function shouldAutoDeliverCustomerReply(
  reply: Pick<AiRoutingDecision, "action" | "handoffCategory">,
): boolean {
  if (reply.handoffCategory === "SYSTEM_ERROR") return false;
  return true;
}

export function initialCustomerReplyStatus(
  reply: Pick<AiRoutingDecision, "action" | "handoffCategory">,
  deliveryKind: "platform" | "web" = "platform",
): "SENDING" | "SENT" | "FAILED" {
  if (!shouldAutoDeliverCustomerReply(reply)) {
    return "FAILED";
  }
  return deliveryKind === "web" ? "SENT" : "SENDING";
}
