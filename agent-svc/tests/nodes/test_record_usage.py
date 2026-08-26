from agent_svc.state import AgentState
from agent_svc.nodes.record_usage import record_usage

def test_record_usage_reports(monkeypatch):
    posted = {}
    import agent_svc.tools.http_client as hc
    monkeypatch.setattr(hc, "run_tool", lambda tool, args, tcid, correlation_id=None: posted.update(args) or {"ok": True})
    state: AgentState = {"messages": [], "business_profile_id": 1, "user_id": 2, "stage": "fast",
                         "usage": {"tokens": 10}}
    out = record_usage(state)
    assert posted["tokens"] == 10
