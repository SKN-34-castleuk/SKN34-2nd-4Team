"""고객 분석 결과를 캠페인 업무로 전환하고 처리하는 API입니다."""

from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException, Query, status as http_status
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from .auth import get_current_user, require_roles
from ...database import get_db
from ...enums import CampaignStatus, UserRole
from ...models import CampaignTarget, CustomerInsight, User
from ...schemas import (
    CampaignTargetCreateRequest,
    CampaignTargetListResponse,
    CampaignTargetResponse,
    CampaignTargetUpdateRequest,
)
from ...services.campaign_service import (
    create_campaign_target,
    fetch_campaign_targets,
    update_campaign_target,
)


campaigns_router = APIRouter(
    prefix="/api/v1/campaign-targets",
    tags=["campaign-targets"],
)
MUTATING_ROLES = (UserRole.ADMIN, UserRole.OPERATIONS, UserRole.MARKETING)


def _to_campaign_response(target: CampaignTarget) -> CampaignTargetResponse:
    return CampaignTargetResponse(
        id=target.id,
        customer_id=target.customer_id,
        customer_insight_id=target.customer_insight_id,
        campaign_name=target.campaign_name,
        assigned_to_user_id=target.assigned_to_user_id,
        assigned_to_display_name=(
            target.assignee.display_name if target.assignee is not None else None
        ),
        status=target.status,
        processed_at=target.processed_at,
        result=target.result,
        result_notes=target.result_notes,
        created_at=target.created_at,
        updated_at=target.updated_at,
    )


@campaigns_router.get(
    "",
    response_model=CampaignTargetListResponse,
    summary="캠페인 대상 목록 조회",
)
def list_campaign_targets(
    target_status: CampaignStatus | None = Query(
        default=None,
        alias="status",
        description="캠페인 처리 상태 필터",
    ),
    page: int = Query(default=1, ge=1),
    page_size: int = Query(default=20, ge=1, le=100),
    _current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> CampaignTargetListResponse:
    """인증된 사용자가 캠페인 처리 큐를 조회합니다."""
    items, total = fetch_campaign_targets(
        db,
        status=target_status,
        page=page,
        page_size=page_size,
    )
    total_pages = (total + page_size - 1) // page_size if total else 0
    return CampaignTargetListResponse(
        items=[_to_campaign_response(item) for item in items],
        page=page,
        page_size=page_size,
        total=total,
        total_pages=total_pages,
    )


@campaigns_router.post(
    "",
    response_model=CampaignTargetResponse,
    status_code=http_status.HTTP_201_CREATED,
    summary="캠페인 대상 등록",
)
def create_campaign_target_api(
    payload: CampaignTargetCreateRequest,
    _current_user: User = Depends(require_roles(*MUTATING_ROLES)),
    db: Session = Depends(get_db),
) -> CampaignTargetResponse:
    """분석 결과를 캠페인 처리 대상으로 등록합니다."""
    insight = db.get(CustomerInsight, payload.customer_insight_id)
    if insight is None:
        raise HTTPException(
            status_code=http_status.HTTP_404_NOT_FOUND,
            detail="The customer insight was not found.",
        )
    assignee = None
    if payload.assigned_to_user_id is not None:
        assignee = db.get(User, payload.assigned_to_user_id)
        if assignee is None or not assignee.is_active:
            raise HTTPException(
                status_code=http_status.HTTP_404_NOT_FOUND,
                detail="The assigned user was not found.",
            )
    try:
        target = create_campaign_target(
            db,
            insight=insight,
            campaign_name=payload.campaign_name,
            assignee=assignee,
        )
    except IntegrityError:
        db.rollback()
        raise HTTPException(
            status_code=http_status.HTTP_409_CONFLICT,
            detail="The campaign target already exists.",
        ) from None
    return _to_campaign_response(target)


@campaigns_router.patch(
    "/{target_id}",
    response_model=CampaignTargetResponse,
    summary="캠페인 대상 처리 상태 변경",
)
def update_campaign_target_api(
    target_id: int,
    payload: CampaignTargetUpdateRequest,
    _current_user: User = Depends(require_roles(*MUTATING_ROLES)),
    db: Session = Depends(get_db),
) -> CampaignTargetResponse:
    """캠페인 대상의 담당자·상태·처리 결과를 저장합니다."""
    target = db.get(CampaignTarget, target_id)
    if target is None:
        raise HTTPException(
            status_code=http_status.HTTP_404_NOT_FOUND,
            detail="The campaign target was not found.",
        )
    assignee = None
    if payload.assigned_to_user_id is not None:
        assignee = db.get(User, payload.assigned_to_user_id)
        if assignee is None or not assignee.is_active:
            raise HTTPException(
                status_code=http_status.HTTP_404_NOT_FOUND,
                detail="The assigned user was not found.",
            )
    target = update_campaign_target(
        db,
        target=target,
        status=payload.status,
        assignee=assignee,
        result=payload.result,
        result_notes=payload.result_notes,
    )
    return _to_campaign_response(target)
