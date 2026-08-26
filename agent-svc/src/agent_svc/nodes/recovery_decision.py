from agent_svc.state import AgentState

def recovery_decision(state: AgentState) -> dict:
    retry = int(state.get("retry_count", 0)) + 1
    stage = "reasoning" if retry <= 1 else "fallback"
    return {"retry_count": retry, "stage": stage}
