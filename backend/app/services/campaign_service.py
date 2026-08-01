"""캠페인 도메인의 조회·상태 전이·이력·중복 방지 규칙입니다."""

from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime, timezone
from typing import Any

from sqlalchemy import Select, case, func, select
from sqlalchemy.orm import Session, selectinload

from ..enums import (
    CampaignEventType,
    CampaignLifecycleStatus,
    CampaignResultCode,
    CampaignStatus,
    UserRole,
)
from ..models import Campaign, CampaignEvent, CampaignTarget, Customer, CustomerInsight, User


MUTABLE_ASSIGNEE_ROLES = {UserRole.OPERATIONS.value, UserRole.MARKETING.value}
OPEN_TARGET_STATUSES = {
    CampaignStatus.PENDING.value,
    CampaignStatus.ASSIGNED.value,
    CampaignStatus.CONTACTED.value,
}
OPEN_CAMPAIGN_STATUSES = {
    CampaignLifecycleStatus.DRAFT.value,
    CampaignLifecycleStatus.SCHEDULED.value,
    CampaignLifecycleStatus.ACTIVE.value,
    CampaignLifecycleStatus.PAUSED.value,
}

CAMPAIGN_STATUS_TRANSITIONS: dict[str, set[str]] = {
    CampaignLifecycleStatus.DRAFT.value: {
        CampaignLifecycleStatus.SCHEDULED.value,
        CampaignLifecycleStatus.ACTIVE.value,
        CampaignLifecycleStatus.CANCELLED.value,
    },
    CampaignLifecycleStatus.SCHEDULED.value: {
        CampaignLifecycleStatus.ACTIVE.value,
        CampaignLifecycleStatus.PAUSED.value,
        CampaignLifecycleStatus.CANCELLED.value,
    },
    CampaignLifecycleStatus.ACTIVE.value: {
        CampaignLifecycleStatus.PAUSED.value,
        CampaignLifecycleStatus.COMPLETED.value,
        CampaignLifecycleStatus.CANCELLED.value,
    },
    CampaignLifecycleStatus.PAUSED.value: {
        CampaignLifecycleStatus.ACTIVE.value,
        CampaignLifecycleStatus.COMPLETED.value,
        CampaignLifecycleStatus.CANCELLED.value,
    },
    CampaignLifecycleStatus.COMPLETED.value: set(),
    CampaignLifecycleStatus.CANCELLED.value: set(),
}

TARGET_STATUS_TRANSITIONS: dict[str, set[str]] = {
    CampaignStatus.PENDING.value: {
        CampaignStatus.ASSIGNED.value,
        CampaignStatus.CANCELLED.value,
    },
    CampaignStatus.ASSIGNED.value: {
        CampaignStatus.CONTACTED.value,
        CampaignStatus.CANCELLED.value,
    },
    CampaignStatus.CONTACTED.value: {
        CampaignStatus.COMPLETED.value,
        CampaignStatus.CANCELLED.value,
    },
    CampaignStatus.COMPLETED.value: set(),
    CampaignStatus.CANCELLED.value: set(),
}


class CampaignDomainError(ValueError):
    """캠페인 업무 규칙 위반을 나타냅니다."""


class CampaignConflictError(CampaignDomainError):
    """중복 대상·중복 활성 업무처럼 현재 상태와 충돌하는 요청입니다."""


class CampaignTransitionError(CampaignDomainError):
    """허용되지 않은 캠페인 또는 대상 상태 전이입니다."""


class CampaignAssigneeError(CampaignDomainError):
    """캠페인 담당자로 지정할 수 없는 사용자입니다."""


@dataclass(frozen=True)
class CampaignStats:
    """캠페인 대상의 서버 집계 결과입니다."""

    total_targets: int
    unprocessed_targets: int
    contacted_targets: int
    converted_targets: int


@dataclass(frozen=True)
class CampaignTargetPage:
    """필터·페이지네이션 대상 목록과 집계 결과입니다."""

    items: list[CampaignTarget]
    total: int
    stats: CampaignStats


def _target_conditions(
    *,
    campaign_id: int | None = None,
    campaign_name: str | None = None,
    status: CampaignStatus | None = None,
    assigned_to_user_id: int | None = None,
    customer_id: int | None = None,
    converted: bool | None = None,
) -> list[Any]:
    conditions: list[Any] = []
    if campaign_id is not None:
        conditions.append(CampaignTarget.campaign_id == campaign_id)
    if campaign_name is not None:
        conditions.append(CampaignTarget.campaign_name == campaign_name)
    if status is not None:
        conditions.append(CampaignTarget.status == status.value)
    if assigned_to_user_id is not None:
        conditions.append(CampaignTarget.assigned_to_user_id == assigned_to_user_id)
    if customer_id is not None:
        conditions.append(CampaignTarget.customer_id == customer_id)
    if converted is not None:
        conditions.append(CampaignTarget.converted.is_(converted))
    return conditions


def _campaign_stats_query(conditions: list[Any]):
    return select(
        func.count(CampaignTarget.id),
        func.coalesce(
            func.sum(
                case(
                    (CampaignTarget.status.in_(
                        [CampaignStatus.PENDING.value, CampaignStatus.ASSIGNED.value]
                    ), 1),
                    else_=0,
                )
            ),
            0,
        ),
        func.coalesce(
            func.sum(
                case(
                    (CampaignTarget.status.in_(
                        [CampaignStatus.CONTACTED.value, CampaignStatus.COMPLETED.value]
                    ), 1),
                    else_=0,
                )
            ),
            0,
        ),
        func.coalesce(
            func.sum(case((CampaignTarget.converted.is_(True), 1), else_=0)),
            0,
        ),
    ).where(*conditions)


def _to_stats(row: Any) -> CampaignStats:
    values = tuple(row)
    return CampaignStats(
        total_targets=int(values[0] or 0),
        unprocessed_targets=int(values[1] or 0),
        contacted_targets=int(values[2] or 0),
        converted_targets=int(values[3] or 0),
    )


def fetch_campaigns(
    db: Session,
    *,
    status: CampaignLifecycleStatus | None,
    name: str | None,
    created_by_user_id: int | None,
    page: int,
    page_size: int,
) -> tuple[list[Campaign], int, dict[int, CampaignStats]]:
    """캠페인 목록과 캠페인별 서버 집계를 조회합니다."""
    query: Select[tuple[Campaign]] = select(Campaign)
    if status is not None:
        query = query.where(Campaign.status == status.value)
    if name:
        query = query.where(Campaign.name.ilike(f"%{name}%"))
    if created_by_user_id is not None:
        query = query.where(Campaign.created_by_user_id == created_by_user_id)

    total = int(
        db.scalar(
            select(func.count()).select_from(query.order_by(None).subquery())
        )
        or 0
    )
    items = db.scalars(
        query.options(selectinload(Campaign.created_by))
        .order_by(Campaign.created_at.desc(), Campaign.id.desc())
        .offset((page - 1) * page_size)
        .limit(page_size)
    ).all()
    ids = [campaign.id for campaign in items]
    stats_by_campaign: dict[int, CampaignStats] = {}
    if ids:
        rows = db.execute(
            _campaign_stats_query([CampaignTarget.campaign_id.in_(ids)])
            .add_columns(CampaignTarget.campaign_id)
            .group_by(CampaignTarget.campaign_id)
        ).all()
        for row in rows:
            stats_by_campaign[int(row[-1])] = _to_stats(row[:-1])
    return items, total, stats_by_campaign


def fetch_campaign(
    db: Session,
    campaign_id: int,
) -> Campaign | None:
    """캠페인 하나를 담당자·대상·이벤트 관계와 함께 조회합니다."""
    return db.scalar(
        select(Campaign)
        .options(
            selectinload(Campaign.created_by),
            selectinload(Campaign.targets).selectinload(CampaignTarget.assignee),
        )
        .where(Campaign.id == campaign_id)
    )


def validate_campaign_period(
    start_at: datetime | None,
    end_at: datetime | None,
) -> None:
    """캠페인 종료 시각이 시작 시각보다 빠르지 않은지 검증합니다."""
    if start_at is not None and end_at is not None and end_at < start_at:
        raise CampaignDomainError("Campaign end_at must be after start_at.")


def create_campaign(
    db: Session,
    *,
    name: str,
    description: str | None,
    channel: str | None,
    lifecycle_status: CampaignLifecycleStatus,
    start_at: datetime | None,
    end_at: datetime | None,
    actor: User,
) -> Campaign:
    """캠페인 기본 정보와 생성 이벤트를 저장합니다."""
    validate_campaign_period(start_at, end_at)
    campaign = Campaign(
        name=name,
        description=description,
        channel=channel,
        status=lifecycle_status.value,
        start_at=start_at,
        end_at=end_at,
        created_by_user_id=actor.id,
    )
    db.add(campaign)
    db.flush()
    _add_event(
        db,
        campaign=campaign,
        event_type=CampaignEventType.CREATED.value,
        to_status=campaign.status,
        actor=actor,
    )
    db.commit()
    db.refresh(campaign)
    campaign.created_by = actor
    return campaign


def update_campaign(
    db: Session,
    *,
    campaign: Campaign,
    name: str | None,
    description: str | None,
    channel: str | None,
    lifecycle_status: CampaignLifecycleStatus | None,
    start_at: datetime | None,
    end_at: datetime | None,
    actor: User,
    update_period: bool,
) -> Campaign:
    """캠페인 정보와 생명주기 상태를 허용된 범위에서 변경합니다."""
    new_start = start_at if update_period else campaign.start_at
    new_end = end_at if update_period else campaign.end_at
    validate_campaign_period(new_start, new_end)
    if name is not None:
        campaign.name = name
    if update_period:
        campaign.start_at = new_start
        campaign.end_at = new_end
    if description is not None:
        campaign.description = description
    if channel is not None:
        campaign.channel = channel

    if lifecycle_status is not None and lifecycle_status.value != campaign.status:
        allowed = CAMPAIGN_STATUS_TRANSITIONS.get(campaign.status, set())
        if lifecycle_status.value not in allowed:
            raise CampaignTransitionError(
                f"Campaign status cannot change from {campaign.status} "
                f"to {lifecycle_status.value}."
            )
        previous_status = campaign.status
        campaign.status = lifecycle_status.value
        _add_event(
            db,
            campaign=campaign,
            event_type=CampaignEventType.STATUS_CHANGED.value,
            from_status=previous_status,
            to_status=campaign.status,
            actor=actor,
        )
    db.commit()
    db.refresh(campaign)
    campaign.created_by = db.get(User, campaign.created_by_user_id)
    return campaign


def validate_assignee(assignee: User | None) -> None:
    """활성 운영·마케팅 담당자만 캠페인 대상에 지정할 수 있습니다."""
    if assignee is None:
        return
    if not assignee.is_active:
        raise CampaignAssigneeError("The assigned user must be active.")
    if assignee.role not in MUTABLE_ASSIGNEE_ROLES:
        raise CampaignAssigneeError(
            "Only active operations or marketing users can be assigned."
        )


def _add_event(
    db: Session,
    *,
    campaign: Campaign,
    event_type: str,
    actor: User | None,
    target: CampaignTarget | None = None,
    from_status: str | None = None,
    to_status: str | None = None,
    note: str | None = None,
    metadata_json: dict[str, Any] | None = None,
) -> CampaignEvent:
    event = CampaignEvent(
        campaign_id=campaign.id,
        campaign_target_id=target.id if target is not None else None,
        event_type=event_type,
        from_status=from_status,
        to_status=to_status,
        actor_user_id=actor.id if actor is not None else None,
        note=note,
        metadata_json=metadata_json,
    )
    db.add(event)
    return event


def _lock_customer(db: Session, customer_id: int) -> None:
    """동일 고객 동시 타기팅 시 중복 검사를 직렬화합니다."""
    db.execute(
        select(Customer.customer_id)
        .where(Customer.customer_id == customer_id)
        .with_for_update()
    ).first()


def _raise_if_active_duplicate(
    db: Session,
    *,
    customer_id: int,
    excluded_target_id: int | None = None,
) -> None:
    query = (
        select(CampaignTarget.id)
        .join(Campaign, Campaign.id == CampaignTarget.campaign_id)
        .where(
            CampaignTarget.customer_id == customer_id,
            CampaignTarget.status.in_(OPEN_TARGET_STATUSES),
            Campaign.status.in_(OPEN_CAMPAIGN_STATUSES),
        )
        .with_for_update()
    )
    if excluded_target_id is not None:
        query = query.where(CampaignTarget.id != excluded_target_id)
    if db.scalar(query) is not None:
        raise CampaignConflictError(
            "The customer already has an active campaign target."
        )


def create_campaign_target(
    db: Session,
    *,
    campaign: Campaign,
    insight: CustomerInsight,
    assignee: User | None,
    actor: User,
) -> CampaignTarget:
    """캠페인 대상과 생성·배정 이벤트를 저장합니다."""
    if campaign.status not in OPEN_CAMPAIGN_STATUSES:
        raise CampaignConflictError("Targets cannot be added to a closed campaign.")
    validate_assignee(assignee)
    _lock_customer(db, insight.customer_id)
    _raise_if_active_duplicate(db, customer_id=insight.customer_id)

    target = CampaignTarget(
        campaign_id=campaign.id,
        customer_id=insight.customer_id,
        customer_insight_id=insight.id,
        campaign_name=campaign.name,
        assigned_to_user_id=assignee.id if assignee is not None else None,
        status=(
            CampaignStatus.ASSIGNED.value
            if assignee is not None
            else CampaignStatus.PENDING.value
        ),
        converted=False,
    )
    db.add(target)
    db.flush()
    _add_event(
        db,
        campaign=campaign,
        target=target,
        event_type=CampaignEventType.CREATED.value,
        to_status=target.status,
        actor=actor,
    )
    if assignee is not None:
        _add_event(
            db,
            campaign=campaign,
            target=target,
            event_type=CampaignEventType.ASSIGNED.value,
            to_status=target.status,
            actor=actor,
            metadata_json={"assigned_to_user_id": assignee.id},
        )
    db.commit()
    db.refresh(target)
    target.campaign = campaign
    target.assignee = assignee
    return target


def get_or_create_legacy_campaign(
    db: Session,
    *,
    name: str,
    actor: User,
) -> Campaign:
    """기존 campaign_name 요청을 실제 캠페인으로 승격합니다."""
    campaign = db.scalar(select(Campaign).where(Campaign.name == name))
    if campaign is not None:
        return campaign
    campaign = Campaign(
        name=name,
        status=CampaignLifecycleStatus.ACTIVE.value,
        created_by_user_id=actor.id,
    )
    db.add(campaign)
    db.flush()
    _add_event(
        db,
        campaign=campaign,
        event_type=CampaignEventType.CREATED.value,
        to_status=campaign.status,
        actor=actor,
        note="Created from legacy campaign_name target request.",
    )
    return campaign


def update_campaign_target(
    db: Session,
    *,
    target: CampaignTarget,
    status: CampaignStatus | None,
    assignee: User | None,
    result: str | None,
    result_notes: str | None,
    result_code: CampaignResultCode | None,
    converted: bool | None,
    actor: User,
) -> CampaignTarget:
    """대상 상태·담당자·결과를 규칙에 맞게 갱신하고 이벤트를 남깁니다."""
    campaign = target.campaign or db.get(Campaign, target.campaign_id)
    if campaign is None:
        raise CampaignDomainError("The campaign target is not linked to a campaign.")
    if campaign.status in {
        CampaignLifecycleStatus.COMPLETED.value,
        CampaignLifecycleStatus.CANCELLED.value,
    }:
        raise CampaignConflictError("Targets in a closed campaign cannot be changed.")

    validate_assignee(assignee)
    previous_status = target.status
    next_status = status.value if status is not None else target.status
    if assignee is not None and status is None and target.status == CampaignStatus.PENDING.value:
        next_status = CampaignStatus.ASSIGNED.value
    next_assignee_id = (
        assignee.id if assignee is not None else target.assigned_to_user_id
    )
    if next_status == CampaignStatus.ASSIGNED.value and next_assignee_id is None:
        raise CampaignDomainError(
            "An assigned target must have an operations or marketing assignee."
        )
    if next_status != previous_status:
        allowed = TARGET_STATUS_TRANSITIONS.get(previous_status, set())
        if next_status not in allowed:
            raise CampaignTransitionError(
                f"Target status cannot change from {previous_status} to {next_status}."
            )

    if assignee is not None:
        if target.status not in {
            CampaignStatus.PENDING.value,
            CampaignStatus.ASSIGNED.value,
        }:
            raise CampaignTransitionError(
                "A target cannot be reassigned after contact has started."
            )
        target.assigned_to_user_id = assignee.id
        target.assignee = assignee
        _add_event(
            db,
            campaign=campaign,
            target=target,
            event_type=CampaignEventType.ASSIGNED.value,
            from_status=previous_status,
            to_status=next_status,
            actor=actor,
            metadata_json={"assigned_to_user_id": assignee.id},
        )

    if next_status != previous_status:
        target.status = next_status
        if next_status in {
            CampaignStatus.CONTACTED.value,
            CampaignStatus.COMPLETED.value,
            CampaignStatus.CANCELLED.value,
        }:
            target.processed_at = target.processed_at or datetime.now(timezone.utc)
        _add_event(
            db,
            campaign=campaign,
            target=target,
            event_type=CampaignEventType.STATUS_CHANGED.value,
            from_status=previous_status,
            to_status=next_status,
            actor=actor,
        )

    result_changed = result is not None or result_notes is not None or result_code is not None
    if result is not None:
        target.result = result
    if result_notes is not None:
        target.result_notes = result_notes
    if result_code is not None:
        target.result_code = result_code.value
        if result_code == CampaignResultCode.CONVERTED:
            converted = True
    if converted is not None:
        if converted and next_status != CampaignStatus.COMPLETED.value:
            raise CampaignDomainError(
                "A target must be completed before it can be marked converted."
            )
        target.converted = converted
        result_changed = True
    if result_changed:
        _add_event(
            db,
            campaign=campaign,
            target=target,
            event_type=(
                CampaignEventType.CONVERSION_UPDATED.value
                if converted is not None or result_code == CampaignResultCode.CONVERTED
                else CampaignEventType.RESULT_UPDATED.value
            ),
            actor=actor,
            metadata_json={
                "result_code": target.result_code,
                "converted": bool(target.converted),
            },
        )

    db.commit()
    db.refresh(target)
    target.campaign = campaign
    target.assignee = (
        db.get(User, target.assigned_to_user_id)
        if target.assigned_to_user_id is not None
        else None
    )
    return target


def fetch_campaign_targets(
    db: Session,
    *,
    campaign_id: int | None,
    campaign_name: str | None,
    status: CampaignStatus | None,
    assigned_to_user_id: int | None,
    customer_id: int | None,
    converted: bool | None,
    page: int,
    page_size: int,
) -> CampaignTargetPage:
    """캠페인 대상의 서버 필터·페이지네이션·집계를 반환합니다."""
    conditions = _target_conditions(
        campaign_id=campaign_id,
        campaign_name=campaign_name,
        status=status,
        assigned_to_user_id=assigned_to_user_id,
        customer_id=customer_id,
        converted=converted,
    )
    query: Select[tuple[CampaignTarget]] = select(CampaignTarget).where(*conditions)
    total = int(
        db.scalar(
            select(func.count()).select_from(query.order_by(None).subquery())
        )
        or 0
    )
    items = db.scalars(
        query.options(
            selectinload(CampaignTarget.assignee),
            selectinload(CampaignTarget.campaign),
        )
        .order_by(CampaignTarget.created_at.desc(), CampaignTarget.id.desc())
        .offset((page - 1) * page_size)
        .limit(page_size)
    ).all()
    stats = _to_stats(db.execute(_campaign_stats_query(conditions)).one())
    return CampaignTargetPage(items=items, total=total, stats=stats)


def fetch_campaign_events(
    db: Session,
    *,
    campaign_id: int,
    campaign_target_id: int | None,
    page: int,
    page_size: int,
) -> tuple[list[CampaignEvent], int]:
    """캠페인 또는 특정 대상의 이벤트 이력을 조회합니다."""
    query: Select[tuple[CampaignEvent]] = select(CampaignEvent).where(
        CampaignEvent.campaign_id == campaign_id
    )
    if campaign_target_id is not None:
        query = query.where(CampaignEvent.campaign_target_id == campaign_target_id)
    total = int(
        db.scalar(
            select(func.count()).select_from(query.order_by(None).subquery())
        )
        or 0
    )
    events = db.scalars(
        query.options(selectinload(CampaignEvent.actor))
        .order_by(CampaignEvent.created_at.desc(), CampaignEvent.id.desc())
        .offset((page - 1) * page_size)
        .limit(page_size)
    ).all()
    return events, total
