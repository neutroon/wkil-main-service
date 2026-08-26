from agent_svc.state import AgentState
from agent_svc.nodes.parse_decision import parse_decision

def test_parse_decision_extracts():
    state: AgentState = {"messages": [], "business_profile_id": 1, "user_id": 2, "stage": "fast",
                         "decision": {"type": "reply", "confidence": 0.9}}
    out = parse_decision(state)
    assert out["decision"]["type"] == "reply"
