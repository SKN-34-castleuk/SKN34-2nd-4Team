"""모델 배치 실행 상태를 제공하는 인증 API입니다."""

from __future__ import annotations

from datetime import datetime

from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy.orm import Session

from .auth import get_current_user
from ...database import get_db
from ...models import ModelRun, User
from ...schemas import LatestBatchResponse, ModelRunResponse
from ...services.model_run_service import fetch_latest_successful_batch


model_runs_router = APIRouter(
    prefix="/api/v1/model-runs",
    tags=["model-runs"],
)


def _to_model_run_response(run: ModelRun) -> ModelRunResponse:
    return ModelRunResponse.model_validate(run)


@model_runs_router.get(
    "/latest",
    response_model=LatestBatchResponse,
    summary="최근 성공 모델 배치 조회",
)
def get_latest_batch(
    _current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> LatestBatchResponse:
    """대시보드에서 데이터 갱신 시각과 사용 모델을 확인할 수 있게 합니다."""
    runs = fetch_latest_successful_batch(db)
    if not runs:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="No successful model batch was found.",
        )

    started_at = min(run.started_at for run in runs)
    completed_values = [run.completed_at for run in runs if run.completed_at]
    completed_at: datetime | None = max(completed_values) if completed_values else None
    processed_rows = max(
        (run.processed_rows for run in runs if run.processed_rows is not None),
        default=None,
    )
    dataset_sha256 = next(
        (run.dataset_sha256 for run in runs if run.dataset_sha256),
        None,
    )
    return LatestBatchResponse(
        status=runs[0].status,
        started_at=started_at,
        completed_at=completed_at,
        processed_rows=processed_rows,
        dataset_sha256=dataset_sha256,
        runs=[_to_model_run_response(run) for run in runs],
    )
