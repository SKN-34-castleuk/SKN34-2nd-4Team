"""신용카드 고객 이탈 예측 서비스를 제공하는 FastAPI 진입점입니다."""

from __future__ import annotations

from collections.abc import AsyncGenerator
from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import (
    APIRouter,
    Depends,
    FastAPI,
    HTTPException,
    Request,
    status,
)

from .config import APP_NAME, APP_VERSION, get_model_dir
from .model_registry import ModelPredictionError, ModelRegistry
from .schemas import (
    HealthResponse,
    LivenessResponse,
    PredictionRequest,
    PredictionResponse,
)


router = APIRouter()


def get_registry(request: Request) -> ModelRegistry:
    """애플리케이션 시작 시 준비된 모델 레지스트리를 반환합니다."""
    # lifespan이 적재한 객체를 app.state에서 가져와 모든 요청이 공유합니다.
    registry = getattr(request.app.state, "model_registry", None)
    if registry is None or not registry.is_loaded:
        # 모델 미준비 상태는 일시적 서비스 불가로 표현하여 클라이언트가
        # 재시도 여부를 판단할 수 있게 합니다.
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="The model registry is not ready.",
        )
    return registry


@router.get(
    "/live",
    response_model=LivenessResponse,
    tags=["system"],
    summary="API 프로세스 생존 여부 확인",
)
def liveness() -> LivenessResponse:
    """모델 상태와 무관한 API 프로세스의 기본 생존 정보를 반환합니다."""
    return LivenessResponse(
        status="ok",
        service=APP_NAME,
        version=APP_VERSION,
    )


@router.get(
    "/ready",
    response_model=HealthResponse,
    tags=["system"],
    summary="API와 모델의 요청 처리 준비 여부 확인",
)
def readiness(
    registry: ModelRegistry = Depends(get_registry),
) -> HealthResponse:
    """현재 적재된 모델의 준비 상태와 식별 정보를 반환합니다."""
    return HealthResponse(
        status="ok",
        service=APP_NAME,
        version=APP_VERSION,
        **registry.health(),
    )


@router.post(
    "/api/v1/predictions",
    response_model=PredictionResponse,
    tags=["predictions"],
    summary="고객 이탈 가능성 예측",
)
def create_prediction(
    payload: PredictionRequest,
    registry: ModelRegistry = Depends(get_registry),
) -> PredictionResponse:
    """검증된 고객 정보로 이탈 여부와 이탈 확률을 예측합니다."""
    try:
        # API 필드명을 학습 파이프라인의 원본 컬럼명으로 변환한 뒤 예측합니다.
        result = registry.predict(payload.to_model_input())
    except ModelPredictionError as exc:
        # 모델 내부 예외나 상세 경로가 외부 응답에 노출되지 않도록
        # 통일된 오류 메시지로 변환합니다.
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="The model could not produce a prediction.",
        ) from exc
    return PredictionResponse.model_validate(result)


def create_app(model_dir: Path | None = None) -> FastAPI:
    """테스트와 운영 환경에서 모델 경로를 주입할 수 있는 앱을 생성합니다."""

    @asynccontextmanager
    async def lifespan(application: FastAPI) -> AsyncGenerator[None, None]:
        """서버 시작과 종료에 맞춰 공유 모델의 생명주기를 관리합니다."""
        # 모델은 요청마다 다시 읽지 않고 서버 시작 시 한 번만 메모리에 적재합니다.
        registry = ModelRegistry(model_dir or get_model_dir())
        registry.load()
        application.state.model_registry = registry
        yield
        # 애플리케이션 종료 시 공유 상태의 참조를 해제합니다.
        application.state.model_registry = None

    application = FastAPI(
        title=APP_NAME,
        version=APP_VERSION,
        description=(
            "선정된 고객 이탈 분류 모델을 적재하고 고객별 이탈 여부와 "
            "이탈 확률을 예측합니다."
        ),
        lifespan=lifespan,
    )
    application.include_router(router)
    return application


app = create_app()
