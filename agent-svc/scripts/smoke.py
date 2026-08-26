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
