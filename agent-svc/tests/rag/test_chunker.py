from agent_svc.rag.chunker import chunk_business_profile

def test_chunker_emits_identity():
    profile = {"name": "Acme", "faqs": [{"question": "hours", "answer": "9-5"}],
               "knowledgeSections": [{"title": "t", "body": "b"}]}
    chunks = chunk_business_profile(profile)
    types = {c["chunk_type"] for c in chunks}
    assert "identity" in types and "faq" in types
