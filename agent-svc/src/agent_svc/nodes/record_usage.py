from agent_svc.state import AgentState
from agent_svc.tools.http_client import run_tool

def record_usage(state: AgentState) -> dict:
    usage = state.get("usage") or {}
    if usage:
        run_tool("report_usage", {
            "userId": state.get("user_id"),
            "businessProfileId": state.get("business_profile_id"),
            "usage": usage,
        }, tool_call_id="usage")
    return {"usage": usage}
