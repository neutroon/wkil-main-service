from agent_svc.state import AgentState

def test_state_defaults():
    s: AgentState = {
        "messages": [],
        "business_profile_id": 1,
        "user_id": 2,
        "retry_count": 0,
        "stage": "fast",
    }
    assert s["retry_count"] == 0
