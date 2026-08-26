from agent_svc.rag.embeddings import embed_texts

class _FakeEmb:
    def embed_documents(self, t): return [[0.1]*4 for _ in t]
    def embed_query(self, q): return [0.1]*4

def test_embed_texts_shape(monkeypatch):
    monkeypatch.setattr("agent_svc.rag.embeddings._model", lambda: _FakeEmb())
    out = embed_texts(["a", "b"])
    assert len(out) == 2 and len(out[0]) == 4
