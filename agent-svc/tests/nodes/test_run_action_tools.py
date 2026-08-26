from agent_svc.state import AgentState
from agent_svc.nodes.run_action_tools import run_action_tools

def test_dispatches_each_tool_call(monkeypatch):
    dispatched = []
    import agent_svc.tools.http_client as hc
    monkeypatch.setattr(hc, "run_tool",
        lambda tool, args, tcid, correlation_id=None: dispatched.append(tool) or {"ok": True})
    state: AgentState = {"messages": [], "business_profile_id": 1, "user_id": 2, "stage": "fast",
                         "tool_calls": [{"id": "c1", "name": "send_message", "args": {"text": "hi"}}]}
    out = run_action_tools(state)
    assert "send_message" in dispatched
    assert len(out["messages"]) == 1
