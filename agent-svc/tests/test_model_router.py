from agent_svc.model_router import get_chat_model

def test_returns_model_for_stage():
    model = get_chat_model("fast")
    assert model is not None
    # provider-agnostic: must expose invoke/stream interface
    assert hasattr(model, "invoke") and hasattr(model, "stream")
