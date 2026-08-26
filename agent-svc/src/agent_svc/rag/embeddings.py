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
