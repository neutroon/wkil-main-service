from agent_svc.rag.rag_ingest_graph import graph

def test_ingest_graph_compiles():
    assert graph.compile() is not None
