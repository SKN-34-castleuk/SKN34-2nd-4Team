"""분석 결과를 캠페인 대상으로 변환하는 세그먼트 일괄 타기팅 규칙입니다."""

from __future__ import annotations

from dataclasses import dataclass
from datetime import date, datetime, timedelta, timezone
from math import floor
from typing import Any

from sqlalchemy import Select, desc, exists, func, or_, select
from sqlalchemy.orm import Session, selectinload

from ..enums import (
    BulkTargetingRunStatus,
    BulkTargetingSegment,
    CampaignEventType,
    CampaignLifecycleStatus,
    CampaignStatus,
    RiskLevel,
)
from ..models import (
    BulkTargetingRun,
    Campaign,
    CampaignTarget,
    Customer,
    CustomerInsight,
    User,
)
from ..schemas import BulkTargetingPreviewRequest
from .campaign_service import (
    CampaignConflictError,
    CampaignDomainError,
    OPEN_CAMPAIGN_STATUSES,
    OPEN_TARGET_STATUSES,
    _add_event,
    create_campaign_target,
)


DEFAULT_CLUSTER_NAME = "우량(예상이상)"
DEFAULT_CAMPAIGN_NAMES = {
    BulkTargetingSegment.HIGH_RISK_RETENTION.value: "고위험 고객 리텐션 일괄 캠페인",
    BulkTargetingSegment.MEDIUM_REACTIVATION.value: "중위험 고객 재활성화 일괄 캠페인",
    BulkTargetingSegment.LOW_RISK_UPSELL.value: "우량 고객 업셀링 일괄 캠페인",
}


class BulkTargetingDomainError(CampaignDomainError):
    """일괄 타기팅 배치의 업무 규칙 위반입니다."""


class BulkTargetingStateError(BulkTargetingDomainError):
    """일괄 타기팅 배치의 현재 상태와 맞지 않는 요청입니다."""


@dataclass(frozen=True)
class BulkTargetingCandidate:
    """일괄 타기팅 후보와 제외 판정에 필요한 상태입니다."""

    insight: CustomerInsight
    customer: Customer
    has_active_campaign: bool
    recently_contacted: bool


@dataclass(frozen=True)
class BulkTargetingScan:
    """세그먼트 후보 전체와 상호 배타적인 제외 집계입니다."""

    candidates: list[BulkTargetingCandidate]
    segment_matched_count: int
    skipped_active_campaign_count: int
    skipped_recent_contact_count: int
    skipped_opt_out_count: int


def _latest_insight_query(source_as_of_date: date | None) -> Select[Any]:
    """고객별 최신 인사이트를, 필요하면 지정 시점 이전으로 제한합니다."""
    conditions: list[Any] = []
    if source_as_of_date is not None:
        conditions.extend(
            [
                CustomerInsight.as_of_date.is_not(None),
                CustomerInsight.as_of_date <= source_as_of_date,
            ]
        )
    ranked = (
        select(
            CustomerInsight.id.label("insight_id"),
            func.row_number()
            .over(
                partition_by=CustomerInsight.customer_id,
                order_by=(
                    desc(CustomerInsight.scored_at),
                    desc(CustomerInsight.id),
                ),
            )
            .label("row_number"),
        )
        .where(*conditions)
        .subquery()
    )
    return select(CustomerInsight).join(
        ranked,
        ranked.c.insight_id == CustomerInsight.id,
    ).where(ranked.c.row_number == 1)


def _lower_quantile(values: list[float], quantile: float) -> float:
    """외부 통계 패키지 없이 선형 보간으로 하위 분위수를 계산합니다."""
    ordered = sorted(float(value) for value in values)
    if not ordered:
        return 0.0
    position = (len(ordered) - 1) * quantile
    lower = floor(position)
    upper = min(lower + 1, len(ordered) - 1)
    fraction = position - lower
    return ordered[lower] + (ordered[upper] - ordered[lower]) * fraction


def _activity_gap_threshold(
    db: Session,
    *,
    source_as_of_date: date | None,
    quantile: float,
) -> float:
    """최신 분석 결과의 activity_gap 하위 분위수 기준을 계산합니다."""
    latest = _latest_insight_query(source_as_of_date).subquery()
    values = db.scalars(select(latest.c.activity_gap)).all()
    return _lower_quantile(values, quantile)


def _build_rules(
    db: Session,
    payload: BulkTargetingPreviewRequest,
) -> dict[str, Any]:
    """요청값을 immutable 정책 JSON으로 정규화합니다."""
    segment = payload.segment.value
    source_as_of_date = payload.source_as_of_date
    rules: dict[str, Any] = {
        "segment": segment,
        "campaign_name": payload.campaign_name or DEFAULT_CAMPAIGN_NAMES[segment],
        "description": payload.description,
        "channel": payload.channel,
        "assigned_to_user_id": payload.assigned_to_user_id,
        "recent_contact_days": payload.recent_contact_days,
        "activity_gap_quantile": payload.activity_gap_quantile,
        "cluster_name": payload.cluster_name or DEFAULT_CLUSTER_NAME,
        "max_targets": payload.max_targets,
        "source_as_of_date": (
            source_as_of_date.isoformat() if source_as_of_date is not None else None
        ),
    }
    if segment == BulkTargetingSegment.MEDIUM_REACTIVATION.value:
        rules["activity_gap_threshold"] = _activity_gap_threshold(
            db,
            source_as_of_date=source_as_of_date,
            quantile=payload.activity_gap_quantile,
        )
    return rules


def _date_from_rules(rules: dict[str, Any]) -> date | None:
    value = rules.get("source_as_of_date")
    return date.fromisoformat(value) if value else None


def _segment_condition(rules: dict[str, Any]) -> Any:
    segment = str(rules["segment"])
    if segment == BulkTargetingSegment.HIGH_RISK_RETENTION.value:
        return CustomerInsight.risk_level == RiskLevel.HIGH.value
    if segment == BulkTargetingSegment.MEDIUM_REACTIVATION.value:
        return (
            CustomerInsight.risk_level == RiskLevel.MEDIUM.value,
            CustomerInsight.activity_gap <= float(rules["activity_gap_threshold"]),
        )
    if segment == BulkTargetingSegment.LOW_RISK_UPSELL.value:
        return (
            CustomerInsight.risk_level == RiskLevel.LOW.value,
            CustomerInsight.cluster_name == str(rules["cluster_name"]),
        )
    raise BulkTargetingDomainError(f"Unsupported targeting segment: {segment}.")


def _is_recent_contacted_at(value: datetime | None, cutoff: datetime) -> bool:
    if value is None:
        return False
    normalized = value if value.tzinfo is not None else value.replace(tzinfo=timezone.utc)
    return normalized >= cutoff


def _candidate_query(
    rules: dict[str, Any],
    *,
    ignore_run_id: int | None = None,
) -> Select[Any]:
    source_as_of_date = _date_from_rules(rules)
    latest_ids = _latest_insight_query(source_as_of_date).subquery()
    cutoff = datetime.now(timezone.utc) - timedelta(
        days=int(rules["recent_contact_days"])
    )

    active_target_query = (
        select(CampaignTarget.id)
        .join(Campaign, Campaign.id == CampaignTarget.campaign_id)
        .where(
            CampaignTarget.customer_id == Customer.customer_id,
            CampaignTarget.status.in_(OPEN_TARGET_STATUSES),
            Campaign.status.in_(OPEN_CAMPAIGN_STATUSES),
        )
    )
    if ignore_run_id is not None:
        active_target_query = active_target_query.where(
            or_(
                CampaignTarget.bulk_targeting_run_id.is_(None),
                CampaignTarget.bulk_targeting_run_id != ignore_run_id,
            )
        )
    has_active_campaign = active_target_query.correlate(Customer).exists()
    recent_target = (
        select(CampaignTarget.id)
        .where(
            CampaignTarget.customer_id == Customer.customer_id,
            CampaignTarget.status.in_(
                [CampaignStatus.CONTACTED.value, CampaignStatus.COMPLETED.value]
            ),
            CampaignTarget.processed_at >= cutoff,
        )
        .correlate(Customer)
        .exists()
    )

    segment_condition = _segment_condition(rules)
    if isinstance(segment_condition, tuple):
        segment_conditions = list(segment_condition)
    else:
        segment_conditions = [segment_condition]
    query = (
        select(
            CustomerInsight,
            Customer,
            has_active_campaign.label("has_active_campaign"),
            recent_target.label("recent_target"),
        )
        .join(Customer, Customer.customer_id == CustomerInsight.customer_id)
        .where(
            CustomerInsight.id.in_(select(latest_ids.c.id)),
            *segment_conditions,
        )
    )
    segment = str(rules["segment"])
    if segment == BulkTargetingSegment.HIGH_RISK_RETENTION.value:
        query = query.order_by(
            CustomerInsight.churn_probability.desc(),
            CustomerInsight.activity_gap.asc(),
            CustomerInsight.scored_at.desc(),
        )
    elif segment == BulkTargetingSegment.MEDIUM_REACTIVATION.value:
        query = query.order_by(
            CustomerInsight.activity_gap.asc(),
            CustomerInsight.churn_probability.desc(),
            CustomerInsight.scored_at.desc(),
        )
    else:
        query = query.order_by(
            CustomerInsight.expected_transaction_count.desc(),
            CustomerInsight.activity_gap.desc(),
            CustomerInsight.churn_probability.asc(),
        )
    return query


def scan_bulk_targeting(
    db: Session,
    rules: dict[str, Any],
    *,
    ignore_run_id: int | None = None,
) -> BulkTargetingScan:
    """세그먼트와 제외 조건을 적용해 preview 대상과 집계를 계산합니다."""
    candidates: list[BulkTargetingCandidate] = []
    skipped_active = 0
    skipped_recent = 0
    skipped_opt_out = 0
    cutoff = datetime.now(timezone.utc) - timedelta(
        days=int(rules["recent_contact_days"])
    )
    rows = db.execute(_candidate_query(rules, ignore_run_id=ignore_run_id)).all()
    for insight, customer, has_active_campaign, recent_target in rows:
        recently_contacted = _is_recent_contacted_at(customer.last_contacted_at, cutoff) or bool(
            recent_target
        )
        candidate = BulkTargetingCandidate(
            insight=insight,
            customer=customer,
            has_active_campaign=bool(has_active_campaign),
            recently_contacted=recently_contacted,
        )
        if customer.marketing_opt_out:
            skipped_opt_out += 1
        elif candidate.has_active_campaign:
            skipped_active += 1
        elif candidate.recently_contacted:
            skipped_recent += 1
        else:
            candidates.append(candidate)
    return BulkTargetingScan(
        candidates=candidates,
        segment_matched_count=len(rows),
        skipped_active_campaign_count=skipped_active,
        skipped_recent_contact_count=skipped_recent,
        skipped_opt_out_count=skipped_opt_out,
    )


def _apply_scan_counts(run: BulkTargetingRun, scan: BulkTargetingScan) -> None:
    run.eligible_count = len(scan.candidates)
    run.preview_count = min(len(scan.candidates), int(run.rules_json["max_targets"]))
    run.skipped_active_campaign_count = scan.skipped_active_campaign_count
    run.skipped_recent_contact_count = scan.skipped_recent_contact_count
    run.skipped_opt_out_count = scan.skipped_opt_out_count


def preview_bulk_targeting(
    db: Session,
    *,
    payload: BulkTargetingPreviewRequest,
    actor: User,
    rerun_of_id: int | None = None,
) -> tuple[BulkTargetingRun, BulkTargetingScan]:
    """정책을 고정한 preview run을 생성합니다."""
    if payload.assigned_to_user_id is not None:
        assignee = db.get(User, payload.assigned_to_user_id)
        if assignee is None:
            raise BulkTargetingDomainError("The assigned user was not found.")
        from .campaign_service import validate_assignee

        validate_assignee(assignee)
    rules = _build_rules(db, payload)
    scan = scan_bulk_targeting(db, rules)
    run = BulkTargetingRun(
        segment_code=payload.segment.value,
        status=BulkTargetingRunStatus.PREVIEWED.value,
        requested_by_user_id=actor.id,
        rerun_of_id=rerun_of_id,
        source_as_of_date=payload.source_as_of_date,
        rules_json=rules,
    )
    db.add(run)
    db.flush()
    _apply_scan_counts(run, scan)
    db.commit()
    db.refresh(run)
    return run, scan


def execute_bulk_targeting(
    db: Session,
    *,
    run: BulkTargetingRun,
    actor: User,
) -> BulkTargetingRun:
    """preview 정책을 재검증하고 draft 캠페인과 대상을 원자적으로 생성합니다."""
    if run.status != BulkTargetingRunStatus.PREVIEWED.value:
        raise BulkTargetingStateError(
            "Only a previewed bulk targeting run can be executed."
        )
    rules = dict(run.rules_json)
    scan = scan_bulk_targeting(db, rules)
    _apply_scan_counts(run, scan)
    campaign = Campaign(
        name=str(rules["campaign_name"]),
        description=rules.get("description"),
        channel=rules.get("channel"),
        status=CampaignLifecycleStatus.DRAFT.value,
        created_by_user_id=actor.id,
    )
    db.add(campaign)
    db.flush()
    run.campaign_id = campaign.id
    run.campaign = campaign
    run.status = BulkTargetingRunStatus.EXECUTED.value
    run.executed_at = datetime.now(timezone.utc)
    _add_event(
        db,
        campaign=campaign,
        event_type=CampaignEventType.CREATED.value,
        to_status=campaign.status,
        actor=actor,
        note="Created by segment bulk targeting.",
        metadata_json={
            "bulk_targeting_run_id": run.id,
            "segment": run.segment_code,
            "eligible_count": len(scan.candidates),
        },
    )

    assigned_to_user_id = rules.get("assigned_to_user_id")
    assignee = (
        db.get(User, int(assigned_to_user_id))
        if assigned_to_user_id is not None
        else None
    )
    run.created_count = 0
    max_targets = int(rules["max_targets"])
    for candidate in scan.candidates[:max_targets]:
        locked_customer = db.scalar(
            select(Customer)
            .where(Customer.customer_id == candidate.customer.customer_id)
            .with_for_update()
        )
        if locked_customer is None:
            continue
        cutoff = datetime.now(timezone.utc) - timedelta(
            days=int(rules["recent_contact_days"])
        )
        if locked_customer.marketing_opt_out:
            run.skipped_opt_out_count += 1
            continue
        if _is_recent_contacted_at(locked_customer.last_contacted_at, cutoff):
            run.skipped_recent_contact_count += 1
            continue
        try:
            target = create_campaign_target(
                db,
                campaign=campaign,
                insight=candidate.insight,
                assignee=assignee,
                actor=actor,
                commit=False,
            )
        except CampaignConflictError:
            run.skipped_active_campaign_count += 1
            continue
        target.bulk_targeting_run_id = run.id
        run.created_count += 1

    db.commit()
    db.refresh(run)
    return run


def cancel_bulk_targeting(
    db: Session,
    *,
    run: BulkTargetingRun,
    actor: User,
) -> BulkTargetingRun:
    """preview를 폐기하거나 실행된 배치의 미처리 대상을 취소합니다."""
    if run.status == BulkTargetingRunStatus.CANCELLED.value:
        raise BulkTargetingStateError("The bulk targeting run is already cancelled.")
    if run.status == BulkTargetingRunStatus.PREVIEWED.value:
        run.status = BulkTargetingRunStatus.CANCELLED.value
        run.cancelled_at = datetime.now(timezone.utc)
        db.commit()
        db.refresh(run)
        return run

    now = datetime.now(timezone.utc)
    cancelled_count = 0
    targets = db.scalars(
        select(CampaignTarget)
        .where(
            CampaignTarget.bulk_targeting_run_id == run.id,
            CampaignTarget.status.in_(
                [CampaignStatus.PENDING.value, CampaignStatus.ASSIGNED.value]
            ),
        )
        .options(selectinload(CampaignTarget.campaign))
        .with_for_update()
    ).all()
    for target in targets:
        previous_status = target.status
        target.status = CampaignStatus.CANCELLED.value
        target.processed_at = now
        if target.campaign is not None:
            _add_event(
                db,
                campaign=target.campaign,
                target=target,
                event_type=CampaignEventType.STATUS_CHANGED.value,
                from_status=previous_status,
                to_status=target.status,
                actor=actor,
                note="Cancelled by bulk targeting run.",
            )
        cancelled_count += 1
    run.status = BulkTargetingRunStatus.CANCELLED.value
    run.cancelled_at = now
    run.cancelled_target_count += cancelled_count
    db.commit()
    db.refresh(run)
    return run


def rerun_bulk_targeting(
    db: Session,
    *,
    run: BulkTargetingRun,
    actor: User,
    campaign_name: str | None = None,
    max_targets: int | None = None,
) -> tuple[BulkTargetingRun, BulkTargetingScan]:
    """기존 정책을 복사해 새 preview run을 만들고 이전 배치를 유지합니다."""
    if run.status != BulkTargetingRunStatus.CANCELLED.value:
        raise BulkTargetingStateError(
            "Only a cancelled bulk targeting run can be rerun."
        )
    rules = dict(run.rules_json)
    rules["campaign_name"] = campaign_name or f"{rules['campaign_name']} 재실행"
    if max_targets is not None:
        rules["max_targets"] = max_targets
    payload = BulkTargetingPreviewRequest(
        segment=BulkTargetingSegment(run.segment_code),
        campaign_name=rules["campaign_name"],
        description=rules.get("description"),
        channel=rules.get("channel"),
        assigned_to_user_id=rules.get("assigned_to_user_id"),
        recent_contact_days=int(rules["recent_contact_days"]),
        activity_gap_quantile=float(rules["activity_gap_quantile"]),
        cluster_name=rules.get("cluster_name"),
        max_targets=int(rules["max_targets"]),
        source_as_of_date=_date_from_rules(rules),
    )
    return preview_bulk_targeting(
        db,
        payload=payload,
        actor=actor,
        rerun_of_id=run.id,
    )


def fetch_bulk_targeting_runs(
    db: Session,
    *,
    page: int,
    page_size: int,
) -> tuple[list[BulkTargetingRun], int]:
    """일괄 타기팅 실행 이력을 최신순으로 조회합니다."""
    query = select(BulkTargetingRun)
    total = int(
        db.scalar(select(func.count()).select_from(query.subquery())) or 0
    )
    items = db.scalars(
        query.options(selectinload(BulkTargetingRun.campaign))
        .order_by(BulkTargetingRun.created_at.desc(), BulkTargetingRun.id.desc())
        .offset((page - 1) * page_size)
        .limit(page_size)
    ).all()
    return items, total


def get_bulk_targeting_run(db: Session, run_id: int) -> BulkTargetingRun | None:
    """일괄 타기팅 배치 하나를 조회합니다."""
    return db.scalar(
        select(BulkTargetingRun)
        .options(selectinload(BulkTargetingRun.campaign))
        .where(BulkTargetingRun.id == run_id)
    )
