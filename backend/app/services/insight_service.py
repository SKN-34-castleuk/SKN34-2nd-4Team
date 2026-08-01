"""고객 분석 결과 조회에 필요한 데이터 접근·조회 규칙입니다."""

from __future__ import annotations

from dataclasses import dataclass

from sqlalchemy import Select, desc, func, select
from sqlalchemy.orm import Session, selectinload

from ..enums import RiskLevel
from ..models import CustomerInsight


@dataclass(frozen=True)
class InsightFilters:
    """최신 고객 분석 결과에 적용할 조회 조건입니다."""

    risk_level: RiskLevel | None = None
    cluster_name: str | None = None
    customer_id: int | None = None


@dataclass(frozen=True)
class InsightPage:
    """페이지 결과와 필터 기준 요약 통계입니다."""

    items: list[CustomerInsight]
    page: int
    page_size: int
    total: int
    total_pages: int
    average_churn_probability: float
    risk_counts: dict[str, int]
    cluster_counts: dict[str, int]


def _latest_query() -> Select[tuple[CustomerInsight]]:
    """고객별 최신 분석 스냅샷만 선택하는 기본 쿼리입니다."""
    ranked_insights = (
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
        .subquery()
    )
    return (
        select(CustomerInsight)
        .join(
            ranked_insights,
            ranked_insights.c.insight_id == CustomerInsight.id,
        )
        .where(ranked_insights.c.row_number == 1)
    )


def _filtered_query(filters: InsightFilters) -> Select[tuple[CustomerInsight]]:
    """최신 스냅샷 쿼리에 필터를 적용합니다."""
    conditions = []
    if filters.risk_level is not None:
        conditions.append(CustomerInsight.risk_level == filters.risk_level.value)
    if filters.cluster_name is not None:
        conditions.append(CustomerInsight.cluster_name == filters.cluster_name)
    if filters.customer_id is not None:
        conditions.append(CustomerInsight.customer_id == filters.customer_id)
    return _latest_query().where(*conditions)


def fetch_insight_page(
    db: Session,
    *,
    filters: InsightFilters,
    sort_by: str,
    sort_order: str,
    page: int,
    page_size: int,
) -> InsightPage:
    """최신 분석 결과 목록과 요약 통계를 조회합니다."""
    query = _filtered_query(filters)
    filtered_subquery = query.order_by(None).subquery()
    total = int(
        db.scalar(select(func.count()).select_from(filtered_subquery)) or 0
    )
    risk_rows = db.execute(
        select(
            filtered_subquery.c.risk_level,
            func.count().label("count"),
        ).group_by(filtered_subquery.c.risk_level)
    ).all()
    cluster_rows = db.execute(
        select(
            filtered_subquery.c.cluster_name,
            func.count().label("count"),
        ).group_by(filtered_subquery.c.cluster_name)
    ).all()
    average_probability = db.scalar(
        select(func.avg(filtered_subquery.c.churn_probability))
    )

    sort_column = {
        "churn_probability": CustomerInsight.churn_probability,
        "activity_gap": CustomerInsight.activity_gap,
        "scored_at": CustomerInsight.scored_at,
    }[sort_by]
    ordered_query = query.order_by(
        sort_column.asc() if sort_order == "asc" else sort_column.desc(),
        CustomerInsight.id.desc(),
    )
    items = db.scalars(
        ordered_query
        .options(selectinload(CustomerInsight.customer))
        .offset((page - 1) * page_size)
        .limit(page_size)
    ).all()
    total_pages = (total + page_size - 1) // page_size if total else 0
    return InsightPage(
        items=items,
        page=page,
        page_size=page_size,
        total=total,
        total_pages=total_pages,
        average_churn_probability=float(average_probability or 0.0),
        risk_counts={str(row[0]): int(row[1]) for row in risk_rows},
        cluster_counts={str(row[0]): int(row[1]) for row in cluster_rows},
    )


def fetch_latest_customer_insight(
    db: Session,
    customer_id: int,
) -> CustomerInsight | None:
    """고객 한 명의 최신 분석 결과와 고객 특성을 조회합니다."""
    query = _filtered_query(InsightFilters(customer_id=customer_id)).options(
        selectinload(CustomerInsight.customer)
    )
    return db.scalar(query)
