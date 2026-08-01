"""모델 배치 실행 이력 조회 규칙입니다."""

from __future__ import annotations

from sqlalchemy import select
from sqlalchemy.orm import Session

from ..enums import ModelRunStatus
from ..models import ModelRun


def fetch_latest_successful_batch(db: Session) -> list[ModelRun]:
    """분류·회귀·군집별 가장 최근 성공 실행을 반환합니다."""
    runs = db.scalars(
        select(ModelRun)
        .where(ModelRun.status == ModelRunStatus.SUCCEEDED.value)
        .where(ModelRun.task.in_(["classification", "regression", "clustering"]))
        .order_by(ModelRun.started_at.desc(), ModelRun.id.desc())
    ).all()
    latest_by_task: dict[str, ModelRun] = {}
    for run in runs:
        latest_by_task.setdefault(run.task, run)
    return [
        latest_by_task[task]
        for task in ("classification", "regression", "clustering")
        if task in latest_by_task
    ]
