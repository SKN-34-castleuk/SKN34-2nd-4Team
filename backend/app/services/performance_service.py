"""캠페인 A/B 실험·전환·유지·수익 성과를 서버에서 집계합니다."""

from __future__ import annotations

from collections import defaultdict
from dataclasses import dataclass
from datetime import datetime, timezone
from typing import Iterable

from sqlalchemy import select
from sqlalchemy.orm import Session

from ..enums import CampaignStatus, ExperimentGroup
from ..models import Campaign, CampaignTarget, User


@dataclass(frozen=True)
class PerformanceMetrics:
    target_count: int
    treatment_count: int
    control_count: int
    contacted_count: int
    converted_count: int
    retained_count: int
    retention_observed_count: int
    contact_rate: float
    conversion_rate: float
    retention_rate: float | None
    treatment_contact_rate: float | None
    control_contact_rate: float | None
    treatment_conversion_rate: float | None
    control_conversion_rate: float | None
    treatment_retention_rate: float | None
    control_retention_rate: float | None
    incremental_conversion_effect: float | None
    incremental_retention_effect: float | None
    total_cost: float
    total_revenue: float
    roi: float | None


@dataclass(frozen=True)
class PerformanceRow:
    target: CampaignTarget
    campaign: Campaign
    assignee_label: str | None


def _rate(numerator: int, denominator: int) -> float:
    if denominator == 0:
        return 0.0
    return numerator / denominator


def _optional_rate(numerator: int, denominator: int) -> float | None:
    if denominator == 0:
        return None
    return numerator / denominator


def _is_contacted(target: CampaignTarget) -> bool:
    """치료군의 접촉만 접촉률에 포함하고, 기존 상태값도 호환합니다."""
    if target.experiment_group == ExperimentGroup.CONTROL.value:
        return False
    return bool(
        target.contacted_at is not None
        or target.status
        in {
            CampaignStatus.CONTACTED.value,
            CampaignStatus.COMPLETED.value,
        }
        or target.result_code
        in {
            "contacted",
            "converted",
            "not_converted",
            "no_response",
            "declined",
            "opted_out",
            "invalid_contact",
        }
    )


def _is_converted(target: CampaignTarget) -> bool:
    return bool(target.converted or target.result_code == "converted")


def _group_rows(rows: Iterable[PerformanceRow], key_fn):
    grouped: dict[str, list[PerformanceRow]] = defaultdict(list)
    for row in rows:
        grouped[key_fn(row)].append(row)
    return grouped


def calculate_metrics(rows: list[PerformanceRow]) -> PerformanceMetrics:
    """대상 행 집합에 동일한 성과·비용 계산을 적용합니다."""
    target_count = len(rows)
    treatment_rows = [
        row
        for row in rows
        if row.target.experiment_group != ExperimentGroup.CONTROL.value
    ]
    control_rows = [
        row
        for row in rows
        if row.target.experiment_group == ExperimentGroup.CONTROL.value
    ]

    contacted_rows = [row for row in rows if _is_contacted(row.target)]
    converted_rows = [row for row in rows if _is_converted(row.target)]
    retained_rows = [row for row in rows if row.target.retained is True]
    observed_retention_rows = [row for row in rows if row.target.retained is not None]

    treatment_contacted = sum(_is_contacted(row.target) for row in treatment_rows)
    control_contacted = sum(_is_contacted(row.target) for row in control_rows)
    treatment_converted = sum(_is_converted(row.target) for row in treatment_rows)
    control_converted = sum(_is_converted(row.target) for row in control_rows)
    treatment_retained = sum(row.target.retained is True for row in treatment_rows)
    control_retained = sum(row.target.retained is True for row in control_rows)
    treatment_observed = sum(row.target.retained is not None for row in treatment_rows)
    control_observed = sum(row.target.retained is not None for row in control_rows)

    unique_campaigns = {row.campaign.id: row.campaign for row in rows}
    total_cost = sum(float(campaign.fixed_cost or 0.0) for campaign in unique_campaigns.values())
    total_cost += sum(
        float(row.campaign.cost_per_contact or 0.0) for row in contacted_rows
    )
    total_revenue = sum(
        float(
            row.target.outcome_revenue
            if row.target.outcome_revenue is not None
            else row.campaign.revenue_per_conversion
        )
        for row in converted_rows
    )
    roi = (total_revenue - total_cost) / total_cost if total_cost > 0 else None

    treatment_conversion_rate = _optional_rate(
        treatment_converted,
        len(treatment_rows),
    )
    control_conversion_rate = _optional_rate(control_converted, len(control_rows))
    treatment_retention_rate = _optional_rate(treatment_retained, treatment_observed)
    control_retention_rate = _optional_rate(control_retained, control_observed)
    return PerformanceMetrics(
        target_count=target_count,
        treatment_count=len(treatment_rows),
        control_count=len(control_rows),
        contacted_count=len(contacted_rows),
        converted_count=len(converted_rows),
        retained_count=len(retained_rows),
        retention_observed_count=len(observed_retention_rows),
        contact_rate=_rate(len(contacted_rows), target_count),
        conversion_rate=_rate(len(converted_rows), target_count),
        retention_rate=_optional_rate(len(retained_rows), len(observed_retention_rows)),
        treatment_contact_rate=_optional_rate(treatment_contacted, len(treatment_rows)),
        control_contact_rate=_optional_rate(control_contacted, len(control_rows)),
        treatment_conversion_rate=treatment_conversion_rate,
        control_conversion_rate=control_conversion_rate,
        treatment_retention_rate=treatment_retention_rate,
        control_retention_rate=control_retention_rate,
        incremental_conversion_effect=(
            treatment_conversion_rate - control_conversion_rate
            if treatment_conversion_rate is not None
            and control_conversion_rate is not None
            else None
        ),
        incremental_retention_effect=(
            treatment_retention_rate - control_retention_rate
            if treatment_retention_rate is not None
            and control_retention_rate is not None
            else None
        ),
        total_cost=total_cost,
        total_revenue=total_revenue,
        roi=roi,
    )


def fetch_performance_rows(
    db: Session,
    *,
    campaign_id: int | None = None,
    segment_code: str | None = None,
    assigned_to_user_id: int | None = None,
) -> list[PerformanceRow]:
    """취소 대상을 제외한 성과 원천 데이터를 조회합니다."""
    query = (
        select(CampaignTarget, Campaign, User)
        .join(Campaign, Campaign.id == CampaignTarget.campaign_id)
        .outerjoin(User, User.id == CampaignTarget.assigned_to_user_id)
        .where(CampaignTarget.status != CampaignStatus.CANCELLED.value)
    )
    if campaign_id is not None:
        query = query.where(CampaignTarget.campaign_id == campaign_id)
    if segment_code is not None:
        query = query.where(Campaign.segment_code == segment_code)
    if assigned_to_user_id is not None:
        query = query.where(
            CampaignTarget.assigned_to_user_id == assigned_to_user_id
        )
    rows: list[PerformanceRow] = []
    for target, campaign, assignee in db.execute(query).all():
        rows.append(
            PerformanceRow(
                target=target,
                campaign=campaign,
                assignee_label=assignee.display_name if assignee is not None else None,
            )
        )
    return rows


def build_performance_breakdowns(
    rows: list[PerformanceRow],
    *,
    dimension: str,
) -> list[dict[str, object]]:
    """세그먼트·캠페인·담당자별 비교 응답을 만듭니다."""
    if dimension == "campaign":
        grouped = _group_rows(rows, lambda row: str(row.campaign.id))
        labels = {
            key: group[0].campaign.name for key, group in grouped.items()
        }
    elif dimension == "segment":
        grouped = _group_rows(
            rows,
            lambda row: row.campaign.segment_code or "unsegmented",
        )
        labels = {
            key: ("미분류" if key == "unsegmented" else key)
            for key in grouped
        }
    else:
        grouped = _group_rows(
            rows,
            lambda row: (
                str(row.target.assigned_to_user_id)
                if row.target.assigned_to_user_id is not None
                else "unassigned"
            ),
        )
        labels = {
            key: (
                group[0].assignee_label
                if group[0].assignee_label is not None
                else "미배정"
            )
            for key, group in grouped.items()
        }

    result: list[dict[str, object]] = []
    for key in sorted(grouped):
        group = grouped[key]
        metrics = calculate_metrics(group)
        result.append(
            {
                **metrics.__dict__,
                "key": key,
                "label": labels[key],
                "campaign_count": len({row.campaign.id for row in group}),
            }
        )
    return result


def get_campaign_performance(
    db: Session,
    *,
    campaign_id: int | None = None,
    segment_code: str | None = None,
    assigned_to_user_id: int | None = None,
) -> dict[str, object]:
    """요약과 세 가지 비교 차원을 한 번에 반환합니다."""
    rows = fetch_performance_rows(
        db,
        campaign_id=campaign_id,
        segment_code=segment_code,
        assigned_to_user_id=assigned_to_user_id,
    )
    return {
        "summary": calculate_metrics(rows),
        "by_campaign": build_performance_breakdowns(rows, dimension="campaign"),
        "by_segment": build_performance_breakdowns(rows, dimension="segment"),
        "by_assignee": build_performance_breakdowns(rows, dimension="assignee"),
        "generated_at": datetime.now(timezone.utc),
    }
