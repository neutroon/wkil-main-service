from agent_svc.state import AgentState
from agent_svc.nodes.run_guardrail import run_guardrail

def test_guardrail_passes_clean():
    state: AgentState = {"messages": [], "business_profile_id": 1, "user_id": 2, "stage": "fast"}
    out = run_guardrail(state)
    assert out.get("guardrail_violation") is False
