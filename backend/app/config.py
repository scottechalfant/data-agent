from pydantic_settings import BaseSettings


class Settings(BaseSettings):
    google_application_credentials: str = ""
    google_cloud_project: str = "velky-brands"
    gemini_model: str = "gemini-2.5-pro"
    bq_max_rows: int = 5000
    bq_max_bytes_billed: int = 107_374_182_400  # 100 GB

    gcs_bucket: str = "velky-brands-data-agent"
    gcs_knowledge_prefix: str = "knowledge/"
    gcs_memories_path: str = "memories.md"

    slack_webhook_url: str = ""
    slack_channel: str = "#data-insights"

    # CORS origins for local dev
    cors_origins: list[str] = ["http://localhost:5173", "http://localhost:3000"]

    class Config:
        env_file = ".env"


settings = Settings()
