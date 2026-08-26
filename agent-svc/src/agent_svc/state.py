from typing import Annotated, TypedDict
from langchain_core.messages import BaseMessage
from langgraph.graph.message import add_messages

class AgentState(TypedDict, total=False):
    messages: Annotated[list[BaseMessage], add_messages]
    business_profile_id: int
    user_id: int
    decision: dict
    tool_calls: list[dict]
    usage: dict
    retry_count: int
    stage: str
