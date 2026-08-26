from langchain_core.messages import ToolMessage
from agent_svc.state import AgentState
from agent_svc.tools.http_client import run_tool

def run_action_tools(state: AgentState) -> dict:
    outputs = []
    for tc in state.get("tool_calls", []):
        result = run_tool(tc["name"], tc.get("args", {}), tc["id"])
        outputs.append(ToolMessage(content=str(result), tool_call_id=tc["id"]))
    return {"messages": outputs, "tool_calls": []}
