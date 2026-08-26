from langgraph.graph import StateGraph, END
from agent_svc.state import AgentState
from agent_svc.nodes.call_model import call_model
from agent_svc.nodes.parse_decision import parse_decision
from agent_svc.nodes.run_guardrail import run_guardrail
from agent_svc.nodes.recovery_decision import recovery_decision
from agent_svc.nodes.structured_output_repair import structured_output_repair
from agent_svc.nodes.run_action_tools import run_action_tools
from agent_svc.nodes.record_usage import record_usage

def _has_tool_calls(state: AgentState) -> str:
    return "tools" if state.get("tool_calls") else "repair"

graph = StateGraph(AgentState)
graph.add_node("call_model", call_model)
graph.add_node("parse_decision", parse_decision)
graph.add_node("run_guardrail", run_guardrail)
graph.add_node("recovery_decision", recovery_decision)
graph.add_node("structured_output_repair", structured_output_repair)
graph.add_node("run_action_tools", run_action_tools)
graph.add_node("record_usage", record_usage)

graph.set_entry_point("call_model")
graph.add_edge("call_model", "parse_decision")
graph.add_edge("parse_decision", "run_guardrail")
graph.add_conditional_edges("run_guardrail", _has_tool_calls, {"tools": "run_action_tools", "repair": "structured_output_repair"})
graph.add_edge("run_action_tools", "call_model")
graph.add_edge("structured_output_repair", "record_usage")
graph.add_edge("record_usage", END)
