from agent_svc.state import AgentState
from agent_svc.nodes.call_model import call_model

def test_call_model_returns_ai_message():
    state: AgentState = {"messages": [], "business_profile_id": 1, "user_id": 2, "stage": "fast"}
    result = call_model(state)
    assert "messages" in result
    assert len(result["messages"]) == 1
