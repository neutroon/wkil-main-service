import os
import httpx
from .schemas import ToolRequest, ToolResponse

_BASE = os.environ.get("MONOLITH_TOOL_BASE_URL", "http://localhost:3000/internal/agent")
_TOKEN = os.environ.get("MONOLITH_SERVICE_TOKEN", "")

def run_tool(tool: str, args: dict, tool_call_id: str, correlation_id: str | None = None) -> dict:
    req = ToolRequest(tool=tool, tool_call_id=tool_call_id, args=args, correlation_id=correlation_id)
    with httpx.Client(base_url=_BASE, timeout=30.0) as c:
        r = c.post("/run", json=req.model_dump(), headers={"x-service-token": _TOKEN})
        r.raise_for_status()
        return ToolResponse(**r.json()).result
