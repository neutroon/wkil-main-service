from agent_svc.rag.qdrant_store import QdrantStore

def test_store_roundtrip():
    s = QdrantStore(url="http://localhost:6333", collection="test")
    s.recreate()
    s.upsert(1, [{"chunk_type": "identity", "content": "x", "vector": [0.1]*4}])
    hits = s.search(1, [0.1]*4, top_k=1)
    assert hits[0]["content"] == "x"
