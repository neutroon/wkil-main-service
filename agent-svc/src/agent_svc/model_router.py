from functools import lru_cache
from langchain_core.language_models.chat_models import BaseChatModel
from langchain_openai import ChatOpenAI
from langchain_anthropic import ChatAnthropic
from langchain_google_genai import ChatGoogleGenerativeAI
from pydantic_settings import BaseSettings, SettingsConfigDict

class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=".env", extra="ignore")
    llm_provider: str = "anthropic"
    llm_model_anthropic: str = "claude-sonnet-4-0"
    llm_model_openai: str = "gpt-5"
    llm_model_google: str = "gemini-2.5-pro"

_settings = Settings()

_STAGE_MODEL = {
    "reasoning": {
        "anthropic": _settings.llm_model_anthropic,
        "openai": _settings.llm_model_openai,
        "google": _settings.llm_model_google,
    },
    "fast": {
        "anthropic": _settings.llm_model_anthropic,
        "openai": _settings.llm_model_openai,
        "google": _settings.llm_model_google,
    },
    "fallback": {
        "anthropic": _settings.llm_model_anthropic,
        "openai": _settings.llm_model_openai,
        "google": _settings.llm_model_google,
    },
}

@lru_cache(maxsize=None)
def get_chat_model(stage: str = "fast") -> BaseChatModel:
    provider = _settings.llm_provider
    model_name = _STAGE_MODEL.get(stage, _STAGE_MODEL["fast"])[provider]
    if provider == "anthropic":
        return ChatAnthropic(model=model_name, temperature=0)
    if provider == "openai":
        return ChatOpenAI(model=model_name, temperature=0)
    if provider == "google":
        return ChatGoogleGenerativeAI(model=model_name, temperature=0)
    raise ValueError(f"Unknown LLM_PROVIDER: {provider}")
