from agent_svc.model_router import get_chat_model
from agent_svc.state import AgentState

def call_model(state: AgentState) -> dict:
    model = get_chat_model(state.get("stage", "fast"))
    response = model.invoke(state["messages"])
    return {"messages": [response]}
