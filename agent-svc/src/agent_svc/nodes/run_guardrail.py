from agent_svc.state import AgentState

def run_guardrail(state: AgentState) -> dict:
    last = state["messages"][-1] if state.get("messages") else None
    text = getattr(last, "content", "") if last else ""
    violation = any(bad in text.lower() for bad in ("ignore previous instructions", "system prompt"))
    if violation:
        return {"guardrail_violation": True, "messages": []}
    return {"guardrail_violation": False}
