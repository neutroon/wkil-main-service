from agent_svc.rag.embeddings import embed_query

CORE_TYPES = ["identity", "contact", "intents"]

def _lexical_filter(business_profile_id: int, terms):
    from qdrant_client.models import Filter, FieldCondition, MatchValue
    return Filter(must=[FieldCondition(key="business_profile_id", match=MatchValue(value=business_profile_id))])

def retrieve(store, business_profile_id: int, query: str, top_k: int = 5):
    vector = embed_query(query)
    vector_hits = store.search(business_profile_id, vector, top_k=top_k * 3)
    ranked = sorted(vector_hits, key=lambda h: h["score"], reverse=True)
    return ranked[:top_k]
