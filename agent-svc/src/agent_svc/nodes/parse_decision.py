from agent_svc.state import AgentState

def parse_decision(state: AgentState) -> dict:
    decision = state.get("decision") or {}
    decision = {
        "type": decision.get("type", "reply"),
        "confidence": float(decision.get("confidence", 0.0)),
    }
    stage = "fast" if decision["confidence"] >= 0.7 else "reasoning"
    return {"decision": decision, "stage": stage}
