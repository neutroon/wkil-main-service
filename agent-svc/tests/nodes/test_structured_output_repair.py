from agent_svc.state import AgentState
from agent_svc.nodes.structured_output_repair import structured_output_repair

def test_repair_extracts_json():
    state: AgentState = {"messages": [], "business_profile_id": 1, "user_id": 2, "stage": "fast",
                         "decision": {"raw": '{"type":"reply"}'}}
    out = structured_output_repair(state)
    assert out["decision"]["type"] == "reply"
