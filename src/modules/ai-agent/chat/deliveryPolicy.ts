import type { AiRoutingDecision } from "@modules/ai-agent/core/aiEngine.utils";

export function shouldAutoDeliverCustomerReply(
  reply: Pick<AiRoutingDecision, "action" | "handoffCategory">,
  isAutoMode: boolean,
): boolean {
  if (!isAutoMode) return false;
  if (reply.handoffCategory === "SYSTEM_ERROR") return false;
  return true;
}

export function initialCustomerReplyStatus(
  reply: Pick<AiRoutingDecision, "action" | "handoffCategory">,
  isAutoMode: boolean,
  deliveryKind: "platform" | "web" = "platform",
): "SENDING" | "SENT" | "PENDING_REVIEW" {
  if (!shouldAutoDeliverCustomerReply(reply, isAutoMode)) {
    return "PENDING_REVIEW";
  }
  return deliveryKind === "web" ? "SENT" : "SENDING";
}
