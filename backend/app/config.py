"""애플리케이션 경로와 환경변수 기반 설정을 관리합니다."""

from __future__ import annotations

import os
from pathlib import Path

from dotenv import load_dotenv


APP_NAME = "Credit Card Customer ML API"
APP_VERSION = "0.1.0"

PROJECT_ROOT = Path(__file__).resolve().parents[2]
DEFAULT_MODEL_DIR = PROJECT_ROOT / "outputs" / "models"
AUTH_COOKIE_NAME = "cardops_access_token"

# 호스트에서 FastAPI를 직접 실행할 때도 프로젝트 루트의 .env를 사용할 수
# 있도록 합니다. Docker Compose에서는 Compose가 환경변수를 직접 주입합니다.
load_dotenv(PROJECT_ROOT / ".env")


def get_model_dir() -> Path:
    """환경변수 또는 기본값으로부터 모델 산출물 디렉터리를 반환합니다."""
    # 배포 환경에서는 MODEL_DIR로 모델 볼륨의 위치를 주입할 수 있습니다.
    configured_path = os.getenv("MODEL_DIR")
    if configured_path:
        return Path(configured_path).expanduser().resolve()

    # 별도 설정이 없으면 프로젝트의 학습 산출물 디렉터리를 사용합니다.
    return DEFAULT_MODEL_DIR.resolve()


def get_database_url() -> str | None:
    """환경변수에서 애플리케이션 데이터베이스 주소를 가져옵니다."""
    return os.getenv("DATABASE_URL") or None


def get_jwt_secret() -> str | None:
    """JWT 서명 키를 가져옵니다. 운영 환경에서는 반드시 직접 지정해야 합니다."""
    return os.getenv("JWT_SECRET") or None


def get_auth_cookie_secure() -> bool:
    """HTTPS 환경에서만 쿠키를 전송할지 환경변수로 결정합니다."""
    return os.getenv("AUTH_COOKIE_SECURE", "false").strip().lower() in {
        "1",
        "true",
        "yes",
        "on",
    }


def get_allow_test_user_seeding() -> bool:
    """로컬 테스트 계정 생성 허용 여부를 반환합니다."""
    return os.getenv("ALLOW_TEST_USER_SEEDING", "false").strip().lower() in {
        "1",
        "true",
        "yes",
        "on",
    }
