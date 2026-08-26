from agent_svc.agent_graph import graph
from langgraph.checkpoint.memory import MemorySaver

def test_graph_compiles():
    app = graph.compile(checkpointer=MemorySaver())
    assert app is not None
