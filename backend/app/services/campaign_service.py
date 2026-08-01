"""캠페인 대상 생성과 업무 상태 변경 규칙입니다."""

from __future__ import annotations

from datetime import datetime, timezone

from sqlalchemy import Select, func, select
from sqlalchemy.orm import Session, selectinload

from ..enums import CampaignStatus
from ..models import CampaignTarget, CustomerInsight, User


def fetch_campaign_targets(
    db: Session,
    *,
    status: CampaignStatus | None,
    page: int,
    page_size: int,
) -> tuple[list[CampaignTarget], int]:
    """캠페인 대상을 상태·페이지 기준으로 조회합니다."""
    query: Select[tuple[CampaignTarget]] = select(CampaignTarget)
    if status is not None:
        query = query.where(CampaignTarget.status == status.value)
    count_query = query.with_only_columns(func.count()).order_by(None)
    total = int(db.scalar(count_query) or 0)
    items = db.scalars(
        query.options(selectinload(CampaignTarget.assignee))
        .order_by(CampaignTarget.created_at.desc(), CampaignTarget.id.desc())
        .offset((page - 1) * page_size)
        .limit(page_size)
    ).all()
    return items, total


def create_campaign_target(
    db: Session,
    *,
    insight: CustomerInsight,
    campaign_name: str,
    assignee: User | None,
) -> CampaignTarget:
    """분석 스냅샷을 새로운 캠페인 업무 대상으로 변환합니다."""
    target = CampaignTarget(
        customer_id=insight.customer_id,
        customer_insight_id=insight.id,
        campaign_name=campaign_name,
        assigned_to_user_id=assignee.id if assignee is not None else None,
        status=(
            CampaignStatus.ASSIGNED.value
            if assignee is not None
            else CampaignStatus.PENDING.value
        ),
    )
    db.add(target)
    db.commit()
    db.refresh(target)
    if assignee is not None:
        target.assignee = assignee
    return target


def update_campaign_target(
    db: Session,
    *,
    target: CampaignTarget,
    status: CampaignStatus | None,
    assignee: User | None,
    result: str | None,
    result_notes: str | None,
) -> CampaignTarget:
    """캠페인 대상의 처리 상태와 결과를 갱신합니다."""
    if status is not None:
        target.status = status.value
        if status in {
            CampaignStatus.CONTACTED,
            CampaignStatus.COMPLETED,
            CampaignStatus.CANCELLED,
        }:
            target.processed_at = datetime.now(timezone.utc)
        else:
            target.processed_at = None
    if assignee is not None:
        target.assigned_to_user_id = assignee.id
        target.assignee = assignee
        if status is None and target.status == CampaignStatus.PENDING.value:
            target.status = CampaignStatus.ASSIGNED.value
    if result is not None:
        target.result = result
    if result_notes is not None:
        target.result_notes = result_notes
    db.commit()
    db.refresh(target)
    if target.assigned_to_user_id is not None:
        target.assignee = db.get(User, target.assigned_to_user_id)
    return target
