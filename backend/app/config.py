"""애플리케이션 경로와 환경변수 기반 설정을 관리합니다."""

from __future__ import annotations

import os
from pathlib import Path


APP_NAME = "Credit Card Customer ML API"
APP_VERSION = "0.1.0"

PROJECT_ROOT = Path(__file__).resolve().parents[2]
DEFAULT_MODEL_DIR = PROJECT_ROOT / "outputs" / "models"


def get_model_dir() -> Path:
    """환경변수 또는 기본값으로부터 모델 산출물 디렉터리를 반환합니다."""
    # 배포 환경에서는 MODEL_DIR로 모델 볼륨의 위치를 주입할 수 있습니다.
    configured_path = os.getenv("MODEL_DIR")
    if configured_path:
        return Path(configured_path).expanduser().resolve()

    # 별도 설정이 없으면 프로젝트의 학습 산출물 디렉터리를 사용합니다.
    return DEFAULT_MODEL_DIR.resolve()
