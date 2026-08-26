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
