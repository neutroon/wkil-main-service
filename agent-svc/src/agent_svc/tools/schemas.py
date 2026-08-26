from pydantic import BaseModel

class ToolRequest(BaseModel):
    tool: str
    tool_call_id: str
    args: dict
    correlation_id: str | None = None

class ToolResponse(BaseModel):
    result: dict
