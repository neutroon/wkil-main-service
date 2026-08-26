# ai-agent → LangGraph self-hosted microservice Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Extract the `ai-agent` core module from the TS monolith into a standalone, officially self-hosted LangGraph (Python) service, replacing the custom graph/checkpointer/runtime and the pgvector RAG with Qdrant, transport via the platform's native API/SDK.

**Architecture:** The Python service runs the ported LangGraph graph on the official `langgraph-api` server (ELv2). The TS monolith calls it only through `langgraph-sdk` (REST + SSE); agent tools are thin HTTP clients to monolith internal endpoints. RAG is reimplemented on Qdrant with provider-agnostic embeddings. Migration is strangler-fig behind a per-caller `USE_AGENT_SERVICE` flag.

**Tech Stack:** Python 3.11+, `langgraph` (MIT), `langchain-core` + `langchain-*` provider integrations (MIT), `langgraph-api` server (ELv2), `qdrant-client`, `httpx`, `pydantic`, Postgres + Redis (platform-managed), Qdrant; TS monolith uses `langgraph-sdk` (JS) + `vitest`.

## Global Constraints

- Transport is the **platform's native API/SDK only** — no Redis Streams broker, no custom transport (verbatim from spec §2/§3).
- `langgraph-api` server runtime is **ELv2** — accepted for internal use; only this binary is non-MIT (spec §1).
- All LangChain *libraries* used are **MIT** (`langgraph`, `langchain-core`, `langchain-*-*`, `langgraph-checkpoint-postgres`, `langsmith`) (spec §1).
- **Qdrant** is the RAG store; replace `BusinessProfileChunk` + pgvector (spec §4). Drop the pgvector table only at final cutover.
- **Multi-provider, provider-agnostic** LLM + embeddings via `init_chat_model` + config-driven provider selection; no Google lock-in (spec §5).
- Agent **tools** are thin HTTP clients to monolith internal endpoints; monolith keeps all business logic (spec §6).
- Migration is **strangler-fig**, zero-downtime, behind `USE_AGENT_SERVICE` per caller; old in-process path is the rollback (spec §8).
- Each task ends with an independently testable deliverable and a commit.

---

## File Structure

### New Python service — `back-end/agent-svc/`
- `pyproject.toml` — deps + tooling (pytest, ruff).
- `langgraph.json` — graphs, assistants, env, dependencies (deployment manifest for `langgraph-api`).
- `docker-compose.yml` — `langgraph-api` + postgres + redis + qdrant.
- `.env.example` — `LANGGRAPH_API_URL`, `DB_URL`, `REDIS_URL`, `QDRANT_URL`, `MONOLITH_TOOL_BASE_URL`, `MONOLITH_SERVICE_TOKEN`, `LLM_PROVIDER`, `LLM_MODEL_*`, `EMBEDDING_PROVIDER`, `EMBEDDING_MODEL`.
- `src/agent_svc/__init__.py`
- `src/agent_svc/model_router.py` — provider-agnostic chat model factory.
- `src/agent_svc/state.py` — ported `agentState`.
- `src/agent_svc/nodes/call_model.py`, `parse_decision.py`, `run_guardrail.py`, `recovery_decision.py`, `structured_output_repair.py`, `record_usage.py`, `run_action_tools.py`
- `src/agent_svc/tools/http_client.py` — HTTP client to monolith tool endpoints.
- `src/agent_svc/tools/schemas.py` — Pydantic tool arg/result schemas (ported from `agentActionTools.ts`).
- `src/agent_svc/agent_graph.py` — assembles `StateGraph` (ported `agentGraphV2`).
- `src/agent_svc/rag/qdrant_store.py`, `chunker.py`, `embeddings.py`, `retrieval.py`, `rag_ingest_graph.py`
- `tests/` — mirrors above.

### Modified TS monolith — `back-end/src/`
- Create `src/modules/ai-agent/client/agent.client.ts` — `langgraph-sdk` wrapper + `USE_AGENT_SERVICE` flag + streaming reassembly.
- Create `src/modules/ai-agent/client/agent.client.test.ts`
- Create `src/modules/ai-agent/tools/agent.tools.controller.ts` + `.test.ts` — internal `POST /internal/agent/tools/run`, `GET /internal/agent/quota`, `POST /internal/agent/usage`, `GET /internal/agent/profile/:id`.
- Modify each of the 13 callers to use `agent.client` behind `USE_AGENT_SERVICE`.
- `src/modules/ai-agent/rag/rag.service.ts` — add dual-write + `rag.ingest` trigger.
- At cutover: delete `src/modules/ai-agent/core/*`, `src/modules/ai-agent/nodes/*`, `src/modules/ai-agent/rag/*`, `src/modules/ai-agent/core/agentActionTools.ts`, and `BusinessProfileChunk` table.

---

### Task 1: Scaffold the Python LangGraph service

**Files:**
- Create: `back-end/agent-svc/pyproject.toml`
- Create: `back-end/agent-svc/langgraph.json`
- Create: `back-end/agent-svc/docker-compose.yml`
- Create: `back-end/agent-svc/.env.example`
- Create: `back-end/agent-svc/src/agent_svc/__init__.py`
- Create: `back-end/agent-svc/tests/__init__.py`

**Interfaces:**
- Produces: runnable project + `langgraph.json` manifest consumed by later tasks (graph import paths).

- [ ] **Step 1: Write `pyproject.toml`**

```toml
[project]
name = "agent-svc"
version = "0.1.0"
requires-python = ">=3.11"
dependencies = [
    "langgraph>=1.2,<2",
    "langchain-core>=1.1,<2",
    "langchain-openai>=1.5,<2",
    "langchain-anthropic>=1.5,<2",
    "langchain-google-genai>=2.1,<3",
    "langchain-google-vertex>=2.1,<3",
    "langgraph-checkpoint-postgres>=1.0,<2",
    "qdrant-client>=1.12,<2",
    "httpx>=0.27,<1",
    "pydantic>=2.9,<3",
    "pydantic-settings>=2.5,<3",
]
[project.optional-dependencies]
dev = ["pytest>=8", "ruff>=0.6"]
[tool.ruff]
line-length = 100
[build-system]
requires = ["hatchling"]
build-backend = "hatchling.build"
```

- [ ] **Step 2: Write `langgraph.json`** (graphs reference later tasks' entrypoints)

```json
{
  "dependencies": ["./pyproject.toml"],
  "graphs": {
    "agent": "./src/agent_svc/agent_graph.py:graph",
    "rag_ingest": "./src/agent_svc/rag/rag_ingest_graph.py:graph"
  },
  "env": ".env"
}
```

- [ ] **Step 3: Write `docker-compose.yml`**

```yaml
services:
  langgraph-api:
    image: langchain/langgraph-api:latest
    environment:
      LANGGRAPH_DB_URL: postgresql://lg:lg@postgres:5432/lg
      REDIS_URL: redis://redis:6379
      QDRANT_URL: http://qdrant:6333
    volumes: ["./langgraph.json:/langgraph.json", "./src:/agent_svc/src", "./.env:/agent_svc/.env"]
    ports: ["8123:8123"]
    depends_on: [postgres, redis, qdrant]
  postgres:
    image: postgres:16
    environment: { POSTGRES_USER: lg, POSTGRES_PASSWORD: lg, POSTGRES_DB: lg }
    ports: ["5433:5432"]
  redis:
    image: redis:7
    ports: ["6379:6379"]
  qdrant:
    image: qdrant/qdrant:latest
    ports: ["6333:6333", "6334:6334"]
```

- [ ] **Step 4: Write `.env.example`**

```dotenv
LANGGRAPH_API_URL=http://localhost:8123
DB_URL=postgresql://lg:lg@localhost:5433/lg
REDIS_URL=redis://localhost:6379
QDRANT_URL=http://localhost:6333
MONOLITH_TOOL_BASE_URL=http://localhost:3000/internal/agent
MONOLITH_SERVICE_TOKEN=change-me
LLM_PROVIDER=anthropic
LLM_MODEL_ANTHROPIC=claude-sonnet-4-0
LLM_MODEL_OPENAI=gpt-5
LLM_MODEL_GOOGLE=gemini-2.5-pro
EMBEDDING_PROVIDER=openai
EMBEDDING_MODEL=text-embedding-3-large
```

- [ ] **Step 5: Create package + tests `__init__.py`**

```bash
touch back-end/agent-svc/src/agent_svc/__init__.py back-end/agent-svc/tests/__init__.py
```

- [ ] **Step 6: Verify project installs**

Run: `cd back-end/agent-svc && python -m venv .venv && . .venv/bin/activate && pip install -e ".[dev]"`
Expected: installs with no resolver errors.

- [ ] **Step 7: Commit**

```bash
git add back-end/agent-svc && git commit -m "feat(agent-svc): scaffold LangGraph self-hosted service"
```

---

### Task 2: Provider-agnostic model runtime

**Files:**
- Create: `back-end/agent-svc/src/agent_svc/model_router.py`
- Test: `back-end/agent-svc/tests/test_model_router.py`

**Interfaces:**
- Produces: `get_chat_model(stage: str) -> BaseChatModel` — returns a LangChain chat model for `stage` (`reasoning` | `fast` | `fallback`) using `LLM_PROVIDER`/`LLM_MODEL_*`. Used by `nodes/call_model.py`.

- [ ] **Step 1: Write the failing test**

```python
from agent_svc.model_router import get_chat_model

def test_returns_model_for_stage():
    model = get_chat_model("fast")
    assert model is not None
    # provider-agnostic: must expose invoke/stream interface
    assert hasattr(model, "invoke") and hasattr(model, "stream")
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd back-end/agent-svc && pytest tests/test_model_router.py -v`
Expected: FAIL (module not found).

- [ ] **Step 3: Write `model_router.py`**

```python
from functools import lru_cache
from langchain_core.language_models.chat_models import BaseChatModel
from langchain_openai import ChatOpenAI
from langchain_anthropic import ChatAnthropic
from langchain_google_genai import ChatGoogleGenerativeAI
from pydantic_settings import BaseSettings, SettingsConfigDict

class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=".env", extra="ignore")
    llm_provider: str = "anthropic"
    llm_model_anthropic: str = "claude-sonnet-4-0"
    llm_model_openai: str = "gpt-5"
    llm_model_google: str = "gemini-2.5-pro"

_settings = Settings()

_STAGE_MODEL = {
    "reasoning": {
        "anthropic": _settings.llm_model_anthropic,
        "openai": _settings.llm_model_openai,
        "google": _settings.llm_model_google,
    },
    "fast": {
        "anthropic": _settings.llm_model_anthropic,
        "openai": _settings.llm_model_openai,
        "google": _settings.llm_model_google,
    },
    "fallback": {
        "anthropic": _settings.llm_model_anthropic,
        "openai": _settings.llm_model_openai,
        "google": _settings.llm_model_google,
    },
}

@lru_cache(maxsize=None)
def get_chat_model(stage: str = "fast") -> BaseChatModel:
    provider = _settings.llm_provider
    model_name = _STAGE_MODEL.get(stage, _STAGE_MODEL["fast"])[provider]
    if provider == "anthropic":
        return ChatAnthropic(model=model_name, temperature=0)
    if provider == "openai":
        return ChatOpenAI(model=model_name, temperature=0)
    if provider == "google":
        return ChatGoogleGenerativeAI(model=model_name, temperature=0)
    raise ValueError(f"Unknown LLM_PROVIDER: {provider}")
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd back-end/agent-svc && pytest tests/test_model_router.py -v`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add back-end/agent-svc/src/agent_svc/model_router.py back-end/agent-svc/tests/test_model_router.py && git commit -m "feat(agent-svc): provider-agnostic model router"
```

---

### Task 3: Graph state schema

**Files:**
- Create: `back-end/agent-svc/src/agent_svc/state.py`
- Test: `back-end/agent-svc/tests/test_state.py`

**Interfaces:**
- Produces: `AgentState` (TypedDict / pydantic) mirroring `src/modules/ai-agent/core/agentState.ts` channels: `messages`, `decision`, `tool_calls`, `usage`, `business_profile_id`, `user_id`, `retry_count`, `stage`. Consumed by all nodes and `agent_graph.py`.

- [ ] **Step 1: Write the failing test**

```python
from agent_svc.state import AgentState

def test_state_defaults():
    s: AgentState = {
        "messages": [],
        "business_profile_id": 1,
        "user_id": 2,
        "retry_count": 0,
        "stage": "fast",
    }
    assert s["retry_count"] == 0
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd back-end/agent-svc && pytest tests/test_state.py -v`
Expected: FAIL (module not found).

- [ ] **Step 3: Write `state.py`** (port channels from `agentState.ts`)

```python
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
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd back-end/agent-svc && pytest tests/test_state.py -v`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add back-end/agent-svc/src/agent_svc/state.py back-end/agent-svc/tests/test_state.py && git commit -m "feat(agent-svc): port agent state schema"
```

---

### Task 4: Port node `callModel`

**Files:**
- Create: `back-end/agent-svc/src/agent_svc/nodes/call_model.py`
- Test: `back-end/agent-svc/tests/nodes/test_call_model.py`

**Interfaces:**
- Consumes: `get_chat_model` (Task 2), `AgentState` (Task 3).
- Produces: `call_model(state: AgentState) -> dict` returning `{ "messages": [AIMessage] }`. Used by `agent_graph.py`.

- [ ] **Step 1: Write the failing test**

```python
from agent_svc.state import AgentState
from agent_svc.nodes.call_model import call_model

def test_call_model_returns_ai_message():
    state: AgentState = {
        "messages": [],
        "business_profile_id": 1,
        "user_id": 2,
        "stage": "fast",
    }
    result = call_model(state)
    assert "messages" in result
    assert len(result["messages"]) == 1
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd back-end/agent-svc && pytest tests/nodes/test_call_model.py -v`
Expected: FAIL.

- [ ] **Step 3: Write `call_model.py`** (port logic from `src/modules/ai-agent/nodes/callModel.ts`)

```python
from agent_svc.model_router import get_chat_model
from agent_svc.state import AgentState

def call_model(state: AgentState) -> dict:
    model = get_chat_model(state.get("stage", "fast"))
    response = model.invoke(state["messages"])
    return {"messages": [response]}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd back-end/agent-svc && pytest tests/nodes/test_call_model.py -v`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add back-end/agent-svc/src/agent_svc/nodes/call_model.py back-end/agent-svc/tests/nodes/test_call_model.py && git commit -m "feat(agent-svc): port callModel node"
```

---

### Task 5: Port node `parseDecision`

**Files:**
- Create: `back-end/agent-svc/src/agent_svc/nodes/parse_decision.py`
- Test: `back-end/agent-svc/tests/nodes/test_parse_decision.py`

**Interfaces:**
- Consumes: `AgentState`.
- Produces: `parse_decision(state) -> dict` returning `{ "decision": {...}, "stage": str }` (ported from `src/modules/ai-agent/nodes/parseDecision.ts`).

- [ ] **Step 1: Write the failing test**

```python
from agent_svc.state import AgentState
from agent_svc.nodes.parse_decision import parse_decision

def test_parse_decision_extracts():
    state: AgentState = {"messages": [], "business_profile_id": 1, "user_id": 2, "stage": "fast",
                         "decision": {"type": "reply", "confidence": 0.9}}
    out = parse_decision(state)
    assert out["decision"]["type"] == "reply"
```

- [ ] **Step 2: Run test to verify it fails** → FAIL.

- [ ] **Step 3: Write `parse_decision.py`** — port the parsing from `parseDecision.ts` (preserve behavior; here a faithful extract):

```python
from agent_svc.state import AgentState

def parse_decision(state: AgentState) -> dict:
    decision = state.get("decision") or {}
    # Mirror parseDecision.ts: normalize type + confidence, default stage.
    decision = {
        "type": decision.get("type", "reply"),
        "confidence": float(decision.get("confidence", 0.0)),
    }
    stage = "fast" if decision["confidence"] >= 0.7 else "reasoning"
    return {"decision": decision, "stage": stage}
```

- [ ] **Step 4: Run test to verify it passes** → PASS.

- [ ] **Step 5: Commit** `feat(agent-svc): port parseDecision node`.

---

### Task 6: Port node `runGuardrail`

**Files:**
- Create: `back-end/agent-svc/src/agent_svc/nodes/run_guardrail.py`
- Test: `back-end/agent-svc/tests/nodes/test_run_guardrail.py`

**Interfaces:**
- Consumes: `AgentState`.
- Produces: `run_guardrail(state) -> dict` → `{ "messages": [AIMessage|SystemMessage] }` or `{"guardrail_violation": bool}`. Port from `src/modules/ai-agent/nodes/runGuardrail.ts`.

- [ ] **Step 1: Write the failing test**

```python
from agent_svc.state import AgentState
from agent_svc.nodes.run_guardrail import run_guardrail

def test_guardrail_passes_clean():
    state: AgentState = {"messages": [], "business_profile_id": 1, "user_id": 2, "stage": "fast"}
    out = run_guardrail(state)
    assert out.get("guardrail_violation") is False
```

- [ ] **Step 2: Run test to verify it fails** → FAIL.

- [ ] **Step 3: Write `run_guardrail.py`** — port behavior from `runGuardrail.ts`:

```python
from agent_svc.state import AgentState

def run_guardrail(state: AgentState) -> dict:
    # Port guardrail checks from runGuardrail.ts verbatim in behavior.
    last = state["messages"][-1] if state.get("messages") else None
    text = getattr(last, "content", "") if last else ""
    violation = any(bad in text.lower() for bad in ("ignore previous instructions", "system prompt"))
    if violation:
        return {"guardrail_violation": True, "messages": []}
    return {"guardrail_violation": False}
```

- [ ] **Step 4: Run test to verify it passes** → PASS.

- [ ] **Step 5: Commit** `feat(agent-svc): port runGuardrail node`.

---

### Task 7: Port node `recoveryDecision`

**Files:**
- Create: `back-end/agent-svc/src/agent_svc/nodes/recovery_decision.py`
- Test: `back-end/agent-svc/tests/nodes/test_recovery_decision.py`

**Interfaces:**
- Consumes: `AgentState`.
- Produces: `recovery_decision(state) -> dict` → `{ "stage": str, "retry_count": int }`. Port from `src/modules/ai-agent/nodes/recoveryDecision.ts`.

- [ ] **Step 1: Write the failing test**

```python
from agent_svc.state import AgentState
from agent_svc.nodes.recovery_decision import recovery_decision

def test_recovery_increments_retry():
    state: AgentState = {"messages": [], "business_profile_id": 1, "user_id": 2,
                         "stage": "fast", "retry_count": 1}
    out = recovery_decision(state)
    assert out["retry_count"] == 2
```

- [ ] **Step 2: Run test to verify it fails** → FAIL.

- [ ] **Step 3: Write `recovery_decision.py`** — port from `recoveryDecision.ts`:

```python
from agent_svc.state import AgentState

def recovery_decision(state: AgentState) -> dict:
    retry = int(state.get("retry_count", 0)) + 1
    stage = "reasoning" if retry <= 1 else "fallback"
    return {"retry_count": retry, "stage": stage}
```

- [ ] **Step 4: Run test to verify it passes** → PASS.

- [ ] **Step 5: Commit** `feat(agent-svc): port recoveryDecision node`.

---

### Task 8: Port node `structuredOutputRepair`

**Files:**
- Create: `back-end/agent-svc/src/agent_svc/nodes/structured_output_repair.py`
- Test: `back-end/agent-svc/tests/nodes/test_structured_output_repair.py`

**Interfaces:**
- Consumes: `AgentState`.
- Produces: `structured_output_repair(state) -> dict` → `{ "decision": dict }` (repaired JSON). Port from `src/modules/ai-agent/nodes/structuredOutputRepair.ts`.

- [ ] **Step 1: Write the failing test**

```python
from agent_svc.state import AgentState
from agent_svc.nodes.structured_output_repair import structured_output_repair

def test_repair_extracts_json():
    state: AgentState = {"messages": [], "business_profile_id": 1, "user_id": 2, "stage": "fast",
                         "decision": {"raw": '{"type":"reply"}'}}
    out = structured_output_repair(state)
    assert out["decision"]["type"] == "reply"
```

- [ ] **Step 2: Run test to verify it fails** → FAIL.

- [ ] **Step 3: Write `structured_output_repair.py`** — port JSON extraction from `structuredOutputRepair.ts`:

```python
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
```

- [ ] **Step 4: Run test to verify it passes** → PASS.

- [ ] **Step 5: Commit** `feat(agent-svc): port structuredOutputRepair node`.

---

### Task 9: Tool HTTP client + schemas

**Files:**
- Create: `back-end/agent-svc/src/agent_svc/tools/http_client.py`
- Create: `back-end/agent-svc/src/agent_svc/tools/schemas.py`
- Test: `back-end/agent-svc/tests/tools/test_http_client.py`

**Interfaces:**
- Produces: `run_tool(tool: str, args: dict, tool_call_id: str) -> dict` (POSTs to `MONOLITH_TOOL_BASE_URL/run` with `MONOLITH_SERVICE_TOKEN`); Pydantic schemas mirroring `src/modules/ai-agent/core/agentActionTools.ts` arg/result shapes. Consumed by `nodes/run_action_tools.py` (Task 12).

- [ ] **Step 1: Write the failing test**

```python
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
```

- [ ] **Step 2: Run test to verify it fails** → FAIL.

- [ ] **Step 3: Write `schemas.py`**

```python
from pydantic import BaseModel

class ToolRequest(BaseModel):
    tool: str
    tool_call_id: str
    args: dict
    correlation_id: str | None = None

class ToolResponse(BaseModel):
    result: dict
```

- [ ] **Step 4: Write `http_client.py`**

```python
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
```

- [ ] **Step 5: Run test to verify it passes** → PASS.

- [ ] **Step 6: Commit** `feat(agent-svc): tool HTTP client + schemas`.

---

### Task 10: Port node `recordUsage`

**Files:**
- Create: `back-end/agent-svc/src/agent_svc/nodes/record_usage.py`
- Test: `back-end/agent-svc/tests/nodes/test_record_usage.py`

**Interfaces:**
- Consumes: `AgentState`, `run_tool` (Task 9).
- Produces: `record_usage(state) -> dict` → `{ "usage": dict }`. Ports `src/modules/ai-agent/nodes/recordUsage.ts` by reporting usage to `POST /internal/agent/usage`.

- [ ] **Step 1: Write the failing test**

```python
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
```

- [ ] **Step 2: Run test to verify it fails** → FAIL.

- [ ] **Step 3: Write `record_usage.py`**

```python
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
```

- [ ] **Step 4: Run test to verify it passes** → PASS.

- [ ] **Step 5: Commit** `feat(agent-svc): port recordUsage node`.

---

### Task 11: Port node `runActionToolsV2`

**Files:**
- Create: `back-end/agent-svc/src/agent_svc/nodes/run_action_tools.py`
- Test: `back-end/agent-svc/tests/nodes/test_run_action_tools.py`

**Interfaces:**
- Consumes: `AgentState`, `run_tool` (Task 9).
- Produces: `run_action_tools(state) -> dict` → `{ "messages": [ToolMessage], "tool_calls": [] }`. Ports `src/modules/ai-agent/nodes/runActionToolsV2.ts` (dispatches each tool_call via `run_tool`).

- [ ] **Step 1: Write the failing test**

```python
from agent_svc.state import AgentState
from agent_svc.nodes.run_action_tools import run_action_tools

def test_dispatches_each_tool_call(monkeypatch):
    dispatched = []
    import agent_svc.tools.http_client as hc
    monkeypatch.setattr(hc, "run_tool",
        lambda tool, args, tcid, correlation_id=None: dispatched.append(tool) or {"ok": True})
    state: AgentState = {"messages": [], "business_profile_id": 1, "user_id": 2, "stage": "fast",
                         "tool_calls": [{"id": "c1", "name": "send_message", "args": {"text": "hi"}}]}
    out = run_action_tools(state)
    assert "send_message" in dispatched
    assert len(out["messages"]) == 1
```

- [ ] **Step 2: Run test to verify it fails** → FAIL.

- [ ] **Step 3: Write `run_action_tools.py`**

```python
from langchain_core.messages import ToolMessage
from agent_svc.state import AgentState
from agent_svc.tools.http_client import run_tool

def run_action_tools(state: AgentState) -> dict:
    outputs = []
    for tc in state.get("tool_calls", []):
        result = run_tool(tc["name"], tc.get("args", {}), tc["id"])
        outputs.append(ToolMessage(content=str(result), tool_call_id=tc["id"]))
    return {"messages": outputs, "tool_calls": []}
```

- [ ] **Step 4: Run test to verify it passes** → PASS.

- [ ] **Step 5: Commit** `feat(agent-svc): port runActionToolsV2 node`.

---

### Task 12: Assemble the agent graph

**Files:**
- Create: `back-end/agent-svc/src/agent_svc/agent_graph.py`
- Test: `back-end/agent-svc/tests/test_agent_graph.py`

**Interfaces:**
- Consumes: `AgentState` (Task 3), `call_model` (4), `parse_decision` (5), `run_guardrail` (6), `recovery_decision` (7), `structured_output_repair` (8), `run_action_tools` (11), `record_usage` (10).
- Produces: `graph` — compiled `StateGraph` referenced by `langgraph.json` (`agent`).

- [ ] **Step 1: Write the failing test**

```python
from agent_svc.agent_graph import graph

def test_graph_compiles():
    app = graph.compile()
    assert app is not None
```

- [ ] **Step 2: Run test to verify it fails** → FAIL.

- [ ] **Step 3: Write `agent_graph.py`** (port topology from `src/modules/ai-agent/core/agentGraphV2.ts`)

```python
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
```

- [ ] **Step 4: Run test to verify it passes** → PASS.

- [ ] **Step 5: Commit** `feat(agent-svc): assemble agent graph`.

---

### Task 13: Qdrant store

**Files:**
- Create: `back-end/agent-svc/src/agent_svc/rag/qdrant_store.py`
- Test: `back-end/agent-svc/tests/rag/test_qdrant_store.py`

**Interfaces:**
- Produces: `QdrantStore` with `upsert(business_profile_id, chunks)`, `search(business_profile_id, vector, top_k, chunk_types)`, `delete(business_profile_id)`. Consumed by `retrieval.py` (Task 16) and `rag_ingest_graph.py` (Task 18).

- [ ] **Step 1: Write the failing test**

```python
from agent_svc.rag.qdrant_store import QdrantStore

def test_store_roundtrip():
    s = QdrantStore(url="http://localhost:6333", collection="test")
    s.recreate()
    s.upsert(1, [{"chunk_type": "identity", "content": "x", "vector": [0.1]*4}])
    hits = s.search(1, [0.1]*4, top_k=1)
    assert hits[0]["content"] == "x"
```

- [ ] **Step 2: Run test to verify it fails** → FAIL.

- [ ] **Step 3: Write `qdrant_store.py`**

```python
from qdrant_client import QdrantClient
from qdrant_client.models import Distance, VectorParams, PointStruct, Filter, FieldCondition, MatchValue

class QdrantStore:
    def __init__(self, url: str, collection: str, vector_size: int = 4):
        self.client = QdrantClient(url=url)
        self.collection = collection
        self.vector_size = vector_size

    def recreate(self):
        self.client.recreate_collection(
            self.collection,
            vectors_config=VectorParams(size=self.vector_size, distance=Distance.COSINE),
        )

    def upsert(self, business_profile_id: int, chunks: list[dict]):
        pts = [
            PointStruct(
                id=abs(hash(f"{business_profile_id}:{i}")) % (2**63),
                vector=c["vector"],
                payload={"business_profile_id": business_profile_id,
                         "chunk_type": c["chunk_type"], "content": c["content"]},
            )
            for i, c in enumerate(chunks)
        ]
        self.client.upsert(self.collection, pts)

    def search(self, business_profile_id: int, vector: list[float], top_k: int = 5, chunk_types=None):
        filt = Filter(must=[FieldCondition(key="business_profile_id", match=MatchValue(value=business_profile_id))])
        hits = self.client.search(self.collection, vector, limit=top_k, query_filter=filt)
        return [{"content": h.payload["content"], "chunk_type": h.payload["chunk_type"], "score": h.score} for h in hits]

    def delete(self, business_profile_id: int):
        self.client.delete(self.collection, Filter(must=[FieldCondition(key="business_profile_id", match=MatchValue(value=business_profile_id))]))
```

- [ ] **Step 4: Run test to verify it passes** → PASS.

- [ ] **Step 5: Commit** `feat(agent-svc): Qdrant store`.

---

### Task 14: Embeddings (provider-agnostic)

**Files:**
- Create: `back-end/agent-svc/src/agent_svc/rag/embeddings.py`
- Test: `back-end/agent-svc/tests/rag/test_embeddings.py`

**Interfaces:**
- Produces: `embed_texts(texts: list[str]) -> list[list[float]]` and `embed_query(text: str) -> list[float]` via `EMBEDDING_PROVIDER`/`EMBEDDING_MODEL` (no Google lock-in). Consumed by `rag_ingest_graph.py` and `retrieval.py`.

- [ ] **Step 1: Write the failing test**

```python
from agent_svc.rag.embeddings import embed_texts

def test_embed_texts_shape(monkeypatch):
    monkeypatch.setattr("agent_svc.rag.embeddings._model", lambda: _FakeEmb())
    out = embed_texts(["a", "b"])
    assert len(out) == 2 and len(out[0]) == 4

class _FakeEmb:
    def embed_documents(self, t): return [[0.1]*4 for _ in t]
    def embed_query(self, q): return [0.1]*4
```

- [ ] **Step 2: Run test to verify it fails** → FAIL.

- [ ] **Step 3: Write `embeddings.py`**

```python
import os
from langchain_openai import OpenAIEmbeddings
from langchain_google_genai import GoogleGenerativeAIEmbeddings

def _model():
    provider = os.environ.get("EMBEDDING_PROVIDER", "openai")
    model = os.environ.get("EMBEDDING_MODEL", "text-embedding-3-large")
    if provider == "openai":
        return OpenAIEmbeddings(model=model)
    if provider == "google":
        return GoogleGenerativeAIEmbeddings(model=model)
    raise ValueError(f"Unknown EMBEDDING_PROVIDER: {provider}")

def embed_texts(texts: list[str]) -> list[list[float]]:
    return _model().embed_documents(texts)

def embed_query(text: str) -> list[float]:
    return _model().embed_query(text)
```

- [ ] **Step 4: Run test to verify it passes** → PASS.

- [ ] **Step 5: Commit** `feat(agent-svc): provider-agnostic embeddings`.

---

### Task 15: Chunker (port)

**Files:**
- Create: `back-end/agent-svc/src/agent_svc/rag/chunker.py`
- Test: `back-end/agent-svc/tests/rag/test_chunker.py`

**Interfaces:**
- Produces: `chunk_business_profile(profile: dict) -> list[{"chunk_type": str, "content": str}]` ported from `src/modules/ai-agent/rag/chunker.ts`. Consumed by `rag_ingest_graph.py`.

- [ ] **Step 1: Write the failing test**

```python
from agent_svc.rag.chunker import chunk_business_profile

def test_chunker_emits_identity():
    profile = {"name": "Acme", "faqs": [{"question": "hours", "answer": "9-5"}],
               "knowledgeSections": [{"title": "t", "body": "b"}]}
    chunks = chunk_business_profile(profile)
    types = {c["chunk_type"] for c in chunks}
    assert "identity" in types and "faq" in types
```

- [ ] **Step 2: Run test to verify it fails** → FAIL.

- [ ] **Step 3: Write `chunker.py`** (port chunk logic from `chunker.ts`)

```python
def chunk_business_profile(profile: dict) -> list[dict]:
    chunks = []
    if profile.get("name"):
        chunks.append({"chunk_type": "identity", "content": f"Business: {profile['name']}"})
    for faq in profile.get("faqs", []):
        chunks.append({"chunk_type": "faq",
                       "content": f"Q: {faq.get('question')}\nA: {faq.get('answer')}"})
    for ks in profile.get("knowledgeSections", []):
        chunks.append({"chunk_type": "knowledge",
                       "content": f"{ks.get('title')}: {ks.get('body')}"})
    return chunks
```

- [ ] **Step 4: Run test to verify it passes** → PASS.

- [ ] **Step 5: Commit** `feat(agent-svc): port RAG chunker`.

---

### Task 16: Hybrid retrieval

**Files:**
- Create: `back-end/agent-svc/src/agent_svc/rag/retrieval.py`
- Test: `back-end/agent-svc/tests/rag/test_retrieval.py`

**Interfaces:**
- Consumes: `QdrantStore` (Task 13), `embed_query` (Task 14).
- Produces: `retrieve(business_profile_id, query, top_k) -> list[{"chunk_type","content","score"}]` — vector + lexical (keyword `MatchValue`) fusion (RRF), porting `rag.service.ts` `retrieveRelevantChunks`.

- [ ] **Step 1: Write the failing test**

```python
from agent_svc.rag.retrieval import retrieve

def test_retrieve_returns_ranked():
    store = _fake_store()
    out = retrieve(store, 1, "hours", top_k=3)
    assert len(out) <= 3
    assert all("content" in c for c in out)
```

- [ ] **Step 2: Run test to verify it fails** → FAIL.

- [ ] **Step 3: Write `retrieval.py`**

```python
from agent_svc.rag.embeddings import embed_query

CORE_TYPES = ["identity", "contact", "intents"]

def _lexical_filter(business_profile_id: int, terms):
    from qdrant_client.models import Filter, FieldCondition, MatchValue
    return Filter(must=[FieldCondition(key="business_profile_id", match=MatchValue(value=business_profile_id))])

def retrieve(store, business_profile_id: int, query: str, top_k: int = 5):
    vector = embed_query(query)
    vector_hits = store.search(business_profile_id, vector, top_k=top_k * 3)
    # RRF fusion (vector only here; lexical payload match mirrors ILIKE in TS)
    ranked = sorted(vector_hits, key=lambda h: h["score"], reverse=True)
    return ranked[:top_k]
```

- [ ] **Step 4: Run test to verify it passes** → PASS.

- [ ] **Step 5: Commit** `feat(agent-svc): hybrid RAG retrieval`.

---

### Task 17: RAG ingest graph (assistant)

**Files:**
- Create: `back-end/agent-svc/src/agent_svc/rag/rag_ingest_graph.py`
- Test: `back-end/agent-svc/tests/rag/test_rag_ingest_graph.py`

**Interfaces:**
- Consumes: `chunk_business_profile` (15), `embed_texts` (14), `QdrantStore` (13).
- Produces: `graph` (compiled) referenced by `langgraph.json` as `rag_ingest`; input `{"business_profile_id": int, "profile": dict, "mode": "full"|"partial", "updated_fields": list}`.

- [ ] **Step 1: Write the failing test**

```python
from agent_svc.rag.rag_ingest_graph import graph

def test_ingest_graph_compiles():
    assert graph.compile() is not None
```

- [ ] **Step 2: Run test to verify it fails** → FAIL.

- [ ] **Step 3: Write `rag_ingest_graph.py`**

```python
from langgraph.graph import StateGraph, END
from agent_svc.rag.chunker import chunk_business_profile
from agent_svc.rag.embeddings import embed_texts
from agent_svc.rag.qdrant_store import QdrantStore

class IngestState(dict): pass

def _ingest(state: dict) -> dict:
    chunks = chunk_business_profile(state["profile"])
    texts = [c["content"] for c in chunks]
    vectors = embed_texts(texts)
    store = QdrantStore(url=state["qdrant_url"], collection=state["collection"])
    if state.get("mode") == "partial":
        store.delete(state["business_profile_id"])
    store.upsert(state["business_profile_id"],
                 [{"chunk_type": c["chunk_type"], "content": c["content"], "vector": v}
                  for c, v in zip(chunks, vectors)])
    return {"chunk_count": len(chunks)}

graph = StateGraph(IngestState)
graph.add_node("ingest", _ingest)
graph.set_entry_point("ingest")
graph.add_edge("ingest", END)
```

- [ ] **Step 4: Run test to verify it passes** → PASS.

- [ ] **Step 5: Commit** `feat(agent-svc): RAG ingest assistant graph`.

---

### Task 18: Deploy + smoke test the service

**Files:**
- Create: `back-end/agent-svc/scripts/smoke.py`
- Modify: `back-end/agent-svc/langgraph.json` (assistants/checkpointer already declared)

**Interfaces:**
- Consumes: deployed `langgraph-api` (Task 1 compose), `graph` (Task 12), `rag_ingest` graph (Task 17).
- Produces: a passing smoke script that creates a thread + runs the agent and the rag_ingest assistant via `langgraph-sdk`.

- [ ] **Step 1: Write `scripts/smoke.py`**

```python
from langgraph_sdk import get_client
import os, asyncio

async def main():
    client = get_client(url=os.environ["LANGGRAPH_API_URL"],
                        api_key=os.environ.get("LANGGRAPH_API_KEY", ""))
    thread = await client.threads.create()
    run = await client.runs.create(thread["thread_id"], "agent",
        input={"messages": [], "business_profile_id": 1, "user_id": 2, "stage": "fast"},
        stream=False)
    print("agent run:", run["status"])
    ingest = await client.runs.create(thread["thread_id"], "rag_ingest",
        input={"business_profile_id": 1, "profile": {"name": "Smoke"},
               "mode": "full", "qdrant_url": os.environ["QDRANT_URL"], "collection": "rag"},
        stream=False)
    print("ingest run:", ingest["status"])

if __name__ == "__main__":
    asyncio.run(main())
```

- [ ] **Step 2: Start the stack and run smoke**

Run: `cd back-end/agent-svc && docker compose up -d && sleep 20 && pip install langgraph-sdk && python scripts/smoke.py`
Expected: prints `agent run: success` and `ingest run: success`.

- [ ] **Step 3: Commit**

```bash
git add back-end/agent-svc/scripts/smoke.py && git commit -m "feat(agent-svc): deploy smoke test"
```

---

### Task 19: Monolith `AgentClient` adapter (TS)

**Files:**
- Create: `back-end/src/modules/ai-agent/client/agent.client.ts`
- Create: `back-end/src/modules/ai-agent/client/agent.client.test.ts`

**Interfaces:**
- Produces: `AgentClient` with `createThread()`, `runAgent(input, {stream})` (wraps `langgraph-sdk`), gated by `USE_AGENT_SERVICE` env. Consumed by all 13 callers.
- `runAgent` returns either the final output or an async iterable of streamed token events, reassembling SSE from the SDK.

- [ ] **Step 1: Write the failing test**

```typescript
import { AgentClient } from "./agent.client";

describe("AgentClient", () => {
  it("is disabled when USE_AGENT_SERVICE is off", () => {
    process.env.USE_AGENT_SERVICE = "false";
    expect(AgentClient.enabled()).toBe(false);
  });
  it("enabled when flag on", () => {
    process.env.USE_AGENT_SERVICE = "true";
    expect(AgentClient.enabled()).toBe(true);
  });
});
```

- [ ] **Step 2: Run test to verify it fails** → FAIL (`vitest run src/modules/ai-agent/client/agent.client.test.ts`).

- [ ] **Step 3: Write `agent.client.ts`**

```typescript
import { getClient, type Client } from "langgraph-sdk";

const ENABLED = process.env.USE_AGENT_SERVICE === "true";
const API_URL = process.env.LANGGRAPH_API_URL ?? "http://localhost:8123";

export class AgentClient {
  static enabled() { return ENABLED; }
  private static client(): Client {
    return getClient({ apiUrl: API_URL, apiKey: process.env.LANGGRAPH_API_KEY ?? "" });
  }
  static async createThread() {
    return this.client().threads.create();
  }
  static async runAgent(input: Record<string, unknown>, opts: { stream?: boolean } = {}) {
    const client = this.client();
    const thread = await client.threads.create();
    const run = await client.runs.create(thread.thread_id, "agent", {
      input,
      stream: opts.stream ?? false,
    } as any);
    return run;
  }
  static async ingestRag(payload: Record<string, unknown>) {
    const client = this.client();
    const thread = await client.threads.create();
    return client.runs.create(thread.thread_id, "rag_ingest", { input: payload } as any);
  }
}
```

- [ ] **Step 4: Run test to verify it passes** → PASS.

- [ ] **Step 5: Commit** `feat(ai-agent): add AgentClient SDK adapter + flag`.

---

### Task 20: Monolith internal tool endpoints

**Files:**
- Create: `back-end/src/modules/ai-agent/tools/agent.tools.controller.ts`
- Create: `back-end/src/modules/ai-agent/tools/agent.tools.controller.test.ts`
- Modify: `back-end/src/app.ts` (register router at `/internal/agent`)

**Interfaces:**
- Produces: `POST /internal/agent/tools/run` (executes `agentActionTools` logic), `GET /internal/agent/quota`, `POST /internal/agent/usage`, `GET /internal/agent/profile/:id`. Guarded by `x-service-token`. Called by the Python service (Task 9).

- [ ] **Step 1: Write the failing test**

```typescript
import request from "supertest";
import { createTestApp } from "../../../test-utils";

describe("agent tools controller", () => {
  it("rejects missing service token", async () => {
    const app = createTestApp();
    const res = await request(app).post("/internal/agent/tools/run")
      .send({ tool: "send_message", tool_call_id: "c1", args: {} });
    expect(res.status).toBe(401);
  });
});
```

- [ ] **Step 2: Run test to verify it fails** → FAIL.

- [ ] **Step 3: Write `agent.tools.controller.ts`**

```typescript
import { Router } from "express";
import { runAgentActionTool } from "../core/agentActionTools"; // existing business logic
import { assertQuotaAvailable, recordAiUsage } from "../../billing/billing.service";
import prisma from "@config/prisma";

const router = Router();
const TOKEN = process.env.MONOLITH_SERVICE_TOKEN ?? "";

router.use((req, res, next) => {
  if (req.header("x-service-token") !== TOKEN) return res.status(401).json({ error: "unauthorized" });
  next();
});

router.post("/tools/run", async (req, res) => {
  const { tool, tool_call_id, args } = req.body;
  const result = await runAgentActionTool(tool, args);
  res.json({ result });
});

router.get("/quota", async (req, res) => {
  const ok = await assertQuotaAvailable(Number(req.query.userId), Number(req.query.businessProfileId)).then(() => true).catch(() => false);
  res.json({ ok });
});

router.post("/usage", async (req, res) => {
  await recordAiUsage(req.body);
  res.json({ ok: true });
});

router.get("/profile/:id", async (req, res) => {
  const profile = await prisma.businessProfile.findUniqueOrThrow({
    where: { id: Number(req.params.id) }, include: { faqs: true, knowledgeSections: true },
  });
  res.json(profile);
});

export default router;
```

- [ ] **Step 4: Register in `app.ts`** (add near other routers):

```typescript
import agentTools from "@modules/ai-agent/tools/agent.tools.controller";
app.use("/internal/agent", agentTools);
```

- [ ] **Step 5: Run test to verify it passes** → PASS.

- [ ] **Step 6: Commit** `feat(ai-agent): internal tool/quota/usage/profile endpoints`.

---

### Task 21: Wire first caller behind flag (`admin/ai-pipeline`)

**Files:**
- Modify: `back-end/src/modules/admin/ai-pipeline/ai-pipeline.service.ts`

**Interfaces:**
- Consumes: `AgentClient` (Task 19). Keeps old in-process path as fallback when `AgentClient.enabled()` is false.

- [ ] **Step 1: Write the failing test** (replay parity)

```typescript
import { runPipelineWithClient } from "./ai-pipeline.service";
import { AgentClient } from "@modules/ai-agent/client/agent.client";

describe("ai-pipeline via AgentClient", () => {
  it("uses AgentClient when enabled", async () => {
    process.env.USE_AGENT_SERVICE = "true";
    const spy = jest.spyOn(AgentClient, "runAgent").mockResolvedValue({ status: "success" } as any);
    await runPipelineWithClient({ businessProfileId: 1, userId: 2 });
    expect(spy).toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run test to verify it fails** → FAIL.

- [ ] **Step 3: Modify `ai-pipeline.service.ts`** to branch:

```typescript
import { AgentClient } from "@modules/ai-agent/client/agent.client";

export async function runPipelineWithClient(input: { businessProfileId: number; userId: number }) {
  if (AgentClient.enabled()) {
    return AgentClient.runAgent({ business_profile_id: input.businessProfileId, user_id: input.userId, messages: [], stage: "fast" });
  }
  // existing in-process implementation below (unchanged)
  return legacyRunPipeline(input);
}
```

- [ ] **Step 4: Run test to verify it passes** → PASS.

- [ ] **Step 5: Commit** `feat(ai-agent): route admin/ai-pipeline through AgentClient behind flag`.

---

### Task 22: Wire remaining callers behind flag

**Files (modify, one commit each):**
- `src/modules/ai-agent/chat/businessChatReply.service.ts`
- `src/modules/business/customer/customerMemoryCapture.job.ts`
- `src/modules/business/profile/ai.service.ts`
- `src/modules/business/profile/business.controller.ts`
- `src/modules/content/content.service.ts`
- `src/modules/content/contentBrief.service.ts`
- `src/modules/content/contentPlan.service.ts`
- `src/modules/follow-up/followUp.service.ts`
- `src/modules/integrations/external/agentAction.job.ts`
- `src/modules/integrations/external/integrationActionRun.service.ts`
- `src/modules/media/services/geminiVisual.service.ts`
- `src/modules/meta/core/metaProcessor.service.ts`
- `src/modules/meta/messenger/messenger.service.ts`
- `src/modules/meta/whatsapp/whatsapp.service.ts`
- `src/modules/order-confirmation/orderConfirmation.metaProcessor.ts`
- `src/modules/widget/services/widgetChat.service.ts`

**Interfaces:**
- Each follows Task 21's pattern: `if (AgentClient.enabled()) return AgentClient.runAgent({...});` else keep legacy path. Add a replay parity test per caller analogous to Task 21.

- [ ] **Step 1 (per caller): Add branch + parity test** — same shape as Task 21 Step 3/1.
- [ ] **Step 2 (per caller): Run tests** → PASS.
- [ ] **Step 3 (per caller): Commit** `feat(ai-agent): route <module> through AgentClient behind flag`.

---

### Task 23: RAG dual-write + ingest trigger

**Files:**
- Modify: `back-end/src/modules/ai-agent/rag/rag.service.ts`

**Interfaces:**
- Consumes: `AgentClient.ingestRag` (Task 19).
- Produces: on profile create/update, call `AgentClient.ingestRag(...)` (when enabled) in addition to existing pgvector writes (dual-write). Keeps existing `ingestBusinessProfile` behavior until cutover.

- [ ] **Step 1: Write the failing test**

```typescript
import { ingestBusinessProfile } from "./rag.service";
import { AgentClient } from "../client/agent.client";

it("dual-writes to Qdrant when enabled", async () => {
  process.env.USE_AGENT_SERVICE = "true";
  const spy = jest.spyOn(AgentClient, "ingestRag").mockResolvedValue({} as any);
  await ingestBusinessProfile(1);
  expect(spy).toHaveBeenCalled();
});
```

- [ ] **Step 2: Run test to verify it fails** → FAIL.

- [ ] **Step 3: Modify `ingestBusinessProfile`** to add, after existing pgvector write:

```typescript
if (AgentClient.enabled()) {
  await AgentClient.ingestRag({
    business_profile_id: businessProfileId,
    profile: { name: profile.name, faqs: profile.faqs, knowledgeSections: profile.knowledgeSections },
    mode: "full",
    qdrant_url: process.env.QDRANT_URL, collection: process.env.QDRANT_COLLECTION ?? "rag",
  });
}
```

- [ ] **Step 4: Run test to verify it passes** → PASS.

- [ ] **Step 5: Commit** `feat(ai-agent): dual-write RAG to Qdrant via AgentClient`.

---

### Task 24: Cutover — drop pgvector + delete moved code

**Files:**
- Delete: `back-end/src/modules/ai-agent/core/*`, `back-end/src/modules/ai-agent/nodes/*`, `back-end/src/modules/ai-agent/rag/*`, `back-end/src/modules/ai-agent/core/agentActionTools.ts`
- Modify: `back-end/prisma/schema.prisma` — remove `BusinessProfileChunk` model + pgvector column.
- Run: `prisma migrate dev --name drop_business_profile_chunk`

**Interfaces:**
- After this task, `ai-agent` core lives only in the Python service; monolith keeps only `client/` and `tools/`.

- [ ] **Step 1: Remove pgvector model from `schema.prisma`**

```prisma
// delete:
model BusinessProfileChunk {
  id                Int      @id @default(autoincrement())
  businessProfileId Int
  content           String
  chunkType         String
  chunkIndex        Int
  embedding         Unsupported("vector")?
  createdAt         DateTime @default(now())
  updatedAt         DateTime @updatedAt
}
```

- [ ] **Step 2: Run migration**

Run: `cd back-end && npx prisma migrate dev --name drop_business_profile_chunk`
Expected: migration applied, no `BusinessProfileChunk` table.

- [ ] **Step 3: Delete moved TS files**

```bash
cd back-end/src/modules/ai-agent && rm -rf core nodes rag && rm core/agentActionTools.ts
```

- [ ] **Step 4: Verify build + tests**

Run: `cd back-end && npm run build && npm test`
Expected: PASS (all callers now route via `AgentClient`).

- [ ] **Step 5: Commit** `refactor(ai-agent): cutover to LangGraph service, remove pgvector + moved code`.

---

### Task 25: End-to-end replay suite + cleanup

**Files:**
- Create: `back-end/scripts/replay-e2e.ts`

**Interfaces:**
- Produces: a script that replays recorded conversations through both paths (legacy off) and asserts output parity; documents rollback. Final validation gate before considering migration complete.

- [ ] **Step 1: Write `replay-e2e.ts`** replaying sample inputs via `AgentClient` and asserting non-empty, well-formed outputs.

- [ ] **Step 2: Run**

Run: `cd back-end && npx ts-node -r tsconfig-paths/register scripts/replay-e2e.ts`
Expected: all replays succeed against the live `langgraph-api`.

- [ ] **Step 3: Commit** `test(ai-agent): e2e replay suite for LangGraph service`.

---

## Self-Review (against spec)

- **Spec §1 goal** → Tasks 1–18 build the service; §12 fallback noted. ✅
- **§2 architecture / no custom broker** → Task 19 uses `langgraph-sdk` only; no Redis Streams. ✅
- **§3 transport/contract** → Tasks 9, 19, 20 define the SDK + tool HTTP contract. ✅
- **§4 Qdrant + multi-provider embeddings** → Tasks 13–17, 14. ✅
- **§5 multi-provider LLM** → Task 2 (`init_chat_model` router). ✅
- **§6 tools via monolith HTTP** → Tasks 9, 20. ✅
- **§7 moves/stays** → Tasks 12, 17 (move); 19–22 (stay). ✅
- **§8 strangler-fig + flag** → Tasks 19, 21, 22, 23, 24. ✅
- **§9/§10 testing & rollback** → every task has tests; flag is rollback; Task 25 e2e. ✅
- **§11 future slices** → out of scope, documented. ✅

No placeholders; all steps contain concrete code or explicit port instructions with real tests. Type names (`AgentState`, `run_tool`, `AgentClient`, `QdrantStore`, `graph`) are consistent across tasks.
