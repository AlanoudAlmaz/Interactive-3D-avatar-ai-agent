"""Runtime configuration loaded from environment variables."""

import os
from dataclasses import dataclass, field
from pathlib import Path

from dotenv import load_dotenv

load_dotenv()

BASE_DIR = Path(__file__).resolve().parent.parent


def _env(name: str, default: str = "") -> str:
    value = os.getenv(name, default)
    return value.strip() if value else default


def _real(value: str) -> bool:
    """Treat empty values and `.env.example` placeholders as unset."""
    return bool(value) and not value.startswith("your_")


@dataclass(frozen=True)
class Settings:
    azure_speech_key: str = field(default_factory=lambda: _env("AZURE_SPEECH_KEY"))
    azure_speech_region: str = field(default_factory=lambda: _env("AZURE_SPEECH_REGION", "uaenorth"))
    voice_en: str = field(default_factory=lambda: _env("ZAYED_VOICE_EN", "en-US-AndrewMultilingualNeural"))
    voice_ar: str = field(default_factory=lambda: _env("ZAYED_VOICE_AR", "ar-AE-HamdanNeural"))

    azure_openai_endpoint: str = field(default_factory=lambda: _env("AZURE_OPENAI_ENDPOINT"))
    azure_openai_key: str = field(default_factory=lambda: _env("AZURE_OPENAI_API_KEY"))
    azure_openai_deployment: str = field(default_factory=lambda: _env("AZURE_OPENAI_DEPLOYMENT"))
    azure_openai_api_version: str = field(default_factory=lambda: _env("AZURE_OPENAI_API_VERSION", "2024-10-21"))
    openai_key: str = field(default_factory=lambda: _env("OPENAI_API_KEY"))
    openai_model: str = field(default_factory=lambda: _env("OPENAI_MODEL", "gpt-4o"))

    knowledge_dir: Path = field(default_factory=lambda: Path(_env("ZAYED_KNOWLEDGE_DIR", str(BASE_DIR / "knowledge"))))
    upload_dir: Path = field(default_factory=lambda: Path(_env("ZAYED_UPLOAD_DIR", str(BASE_DIR / "uploads"))))
    max_upload_mb: int = field(default_factory=lambda: int(_env("ZAYED_MAX_UPLOAD_MB", "25")))
    avatar_url: str = field(default_factory=lambda: _env("ZAYED_AVATAR_URL", "/static/avatar/zayed.json"))
    avatar_body: str = field(default_factory=lambda: _env("ZAYED_AVATAR_BODY", "M"))

    @property
    def azure_speech_enabled(self) -> bool:
        return _real(self.azure_speech_key) and bool(self.azure_speech_region)

    @property
    def azure_openai_enabled(self) -> bool:
        return all(_real(v) for v in (self.azure_openai_endpoint, self.azure_openai_key, self.azure_openai_deployment))

    @property
    def openai_enabled(self) -> bool:
        return _real(self.openai_key)

    @property
    def llm_enabled(self) -> bool:
        return self.azure_openai_enabled or self.openai_enabled


settings = Settings()
