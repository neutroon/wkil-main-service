import json, re
from agent_svc.state import AgentState

def _extract_json_blob(text: str) -> dict:
    m = re.search(r"\{.*\}", text, re.DOTALL)
    return json.loads(m.group(0)) if m else {}

def structured_output_repair(state: AgentState) -> dict:
    raw = state.get("decision", {})
    text = raw.get("raw") if isinstance(raw, dict) else str(raw)
    try:
        return {"decision": _extract_json_blob(text)}
    except Exception:
        return {"decision": {"type": "reply", "error": "unparseable"}}
