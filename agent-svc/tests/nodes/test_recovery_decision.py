from agent_svc.state import AgentState
from agent_svc.nodes.recovery_decision import recovery_decision

def test_recovery_increments_retry():
    state: AgentState = {"messages": [], "business_profile_id": 1, "user_id": 2, "stage": "fast", "retry_count": 1}
    out = recovery_decision(state)
    assert out["retry_count"] == 2
