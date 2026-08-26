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
