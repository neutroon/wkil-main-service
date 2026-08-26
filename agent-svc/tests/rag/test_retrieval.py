from agent_svc.rag.retrieval import retrieve

class _FakeStore:
    def search(self, business_profile_id, vector, top_k=5, chunk_types=None):
        return [{"content": "a", "chunk_type": "faq", "score": 0.9},
                {"content": "b", "chunk_type": "identity", "score": 0.5}]

def test_retrieve_returns_ranked(monkeypatch):
    monkeypatch.setattr("agent_svc.rag.retrieval.embed_query", lambda q: [0.1]*4)
    out = retrieve(_FakeStore(), 1, "hours", top_k=3)
    assert len(out) <= 3
    assert all("content" in c for c in out)
