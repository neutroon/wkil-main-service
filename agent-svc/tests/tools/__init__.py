import os
from agent_svc.tools.http_client import run_tool

def test_run_tool_posts_to_monolith(monkeypatch):
    calls = {}
    import httpx
    class FakeResp:
        status_code = 200
        def raise_for_status(self): pass
        def json(self): return {"result": {"ok": True}}
    class FakeClient:
        def __init__(self, *a, **k): pass
        def __enter__(self): return self
        def __exit__(self, *a): pass
        def post(self, url, json=None, headers=None, timeout=None):
            calls["url"] = url; calls["json"] = json
            return FakeResp()
    monkeypatch.setattr(httpx, "Client", FakeClient)
    out = run_tool("send_message", {"text": "hi"}, "call-1")
    assert out["result"]["ok"] is True
    assert calls["url"].endswith("/run")
