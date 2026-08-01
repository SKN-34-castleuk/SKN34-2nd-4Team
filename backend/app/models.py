"""CardOps 애플리케이션에서 사용하는 SQLAlchemy 데이터베이스 모델입니다."""

from __future__ import annotations

from datetime import date, datetime
from typing import Any

from sqlalchemy import (
    JSON,
    BigInteger,
    Boolean,
    CheckConstraint,
    Date,
    DateTime,
    Float,
    ForeignKey,
    Index,
    Integer,
    String,
    Text,
    UniqueConstraint,
    func,
    text,
)
from sqlalchemy.orm import Mapped, mapped_column, relationship

from .database import Base
from .enums import CampaignStatus, ModelRunStatus, RiskLevel, UserRole


class User(Base):
    """팀 계정, 역할과 Argon2 비밀번호 해시를 저장합니다."""

    __tablename__ = "users"
    __table_args__ = (
        CheckConstraint(
            "role IN ('admin', 'analyst', 'operations', 'marketing')",
            name="ck_users_role",
        ),
    )

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    username: Mapped[str] = mapped_column(
        String(50),
        unique=True,
        index=True,
        nullable=False,
    )
    display_name: Mapped[str] = mapped_column(String(100), nullable=False)
    password_hash: Mapped[str] = mapped_column(String(255), nullable=False)
    role: Mapped[str] = mapped_column(
        String(20),
        nullable=False,
        default=UserRole.ANALYST.value,
        server_default=UserRole.ANALYST.value,
    )
    is_active: Mapped[bool] = mapped_column(
        Boolean,
        nullable=False,
        default=False,
        server_default="0",
    )
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True),
        nullable=False,
        server_default=text("CURRENT_TIMESTAMP"),
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True),
        nullable=False,
        server_default=text("CURRENT_TIMESTAMP"),
        onupdate=func.now(),
    )

    assigned_campaign_targets: Mapped[list[CampaignTarget]] = relationship(
        back_populates="assignee",
        foreign_keys="CampaignTarget.assigned_to_user_id",
    )


class Customer(Base):
    """모델 식별자와 분리된 고객 ID 및 19개 모델 입력 특성을 저장합니다."""

    __tablename__ = "customers"
    __table_args__ = (
        CheckConstraint("customer_age BETWEEN 18 AND 120", name="ck_customers_age"),
        CheckConstraint("gender IN ('F', 'M')", name="ck_customers_gender"),
        CheckConstraint("dependent_count >= 0", name="ck_customers_dependents"),
        CheckConstraint("months_on_book >= 0", name="ck_customers_months_on_book"),
        CheckConstraint(
            "total_relationship_count >= 0",
            name="ck_customers_relationship_count",
        ),
        CheckConstraint(
            "months_inactive_12_mon >= 0",
            name="ck_customers_inactive_months",
        ),
        CheckConstraint(
            "contacts_count_12_mon >= 0",
            name="ck_customers_contacts_count",
        ),
        CheckConstraint("credit_limit >= 0", name="ck_customers_credit_limit"),
        CheckConstraint(
            "total_revolving_bal >= 0",
            name="ck_customers_revolving_balance",
        ),
        CheckConstraint(
            "avg_open_to_buy >= 0",
            name="ck_customers_open_to_buy",
        ),
        CheckConstraint(
            "total_amt_chng_q4_q1 >= 0",
            name="ck_customers_amount_change",
        ),
        CheckConstraint(
            "total_trans_amt >= 0",
            name="ck_customers_transaction_amount",
        ),
        CheckConstraint(
            "total_trans_ct >= 0",
            name="ck_customers_transaction_count",
        ),
        CheckConstraint(
            "total_ct_chng_q4_q1 >= 0",
            name="ck_customers_count_change",
        ),
        CheckConstraint(
            "avg_utilization_ratio BETWEEN 0 AND 1",
            name="ck_customers_utilization_ratio",
        ),
        Index("ix_customers_card_category", "card_category"),
    )

    # Kaggle 원본의 CLIENTNUM을 업무 식별자로 보존하되 모델 입력에는 넣지 않습니다.
    customer_id: Mapped[int] = mapped_column(BigInteger, primary_key=True)
    customer_age: Mapped[int] = mapped_column(Integer, nullable=False)
    gender: Mapped[str] = mapped_column(String(1), nullable=False)
    dependent_count: Mapped[int] = mapped_column(Integer, nullable=False)
    education_level: Mapped[str] = mapped_column(String(30), nullable=False)
    marital_status: Mapped[str] = mapped_column(String(20), nullable=False)
    income_category: Mapped[str] = mapped_column(String(30), nullable=False)
    card_category: Mapped[str] = mapped_column(String(20), nullable=False)
    months_on_book: Mapped[int] = mapped_column(Integer, nullable=False)
    total_relationship_count: Mapped[int] = mapped_column(Integer, nullable=False)
    months_inactive_12_mon: Mapped[int] = mapped_column(Integer, nullable=False)
    contacts_count_12_mon: Mapped[int] = mapped_column(Integer, nullable=False)
    credit_limit: Mapped[float] = mapped_column(Float, nullable=False)
    total_revolving_bal: Mapped[int] = mapped_column(Integer, nullable=False)
    avg_open_to_buy: Mapped[float] = mapped_column(Float, nullable=False)
    total_amt_chng_q4_q1: Mapped[float] = mapped_column(Float, nullable=False)
    total_trans_amt: Mapped[int] = mapped_column(Integer, nullable=False)
    total_trans_ct: Mapped[int] = mapped_column(Integer, nullable=False)
    total_ct_chng_q4_q1: Mapped[float] = mapped_column(Float, nullable=False)
    avg_utilization_ratio: Mapped[float] = mapped_column(Float, nullable=False)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True),
        nullable=False,
        server_default=text("CURRENT_TIMESTAMP"),
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True),
        nullable=False,
        server_default=text("CURRENT_TIMESTAMP"),
        onupdate=func.now(),
    )

    insights: Mapped[list[CustomerInsight]] = relationship(
        back_populates="customer",
        cascade="all, delete-orphan",
        passive_deletes=True,
    )
    feature_snapshots: Mapped[list[CustomerFeatureSnapshot]] = relationship(
        back_populates="customer",
        cascade="all, delete-orphan",
        passive_deletes=True,
    )
    campaign_targets: Mapped[list[CampaignTarget]] = relationship(
        back_populates="customer",
        cascade="all, delete-orphan",
        passive_deletes=True,
    )


class CustomerFeatureSnapshot(Base):
    """분석 당시 고객 19개 입력 특성을 보존하는 시점별 스냅샷입니다."""

    __tablename__ = "customer_feature_snapshots"
    __table_args__ = (
        UniqueConstraint(
            "customer_id",
            "feature_sha256",
            "as_of_date",
            name="uq_customer_feature_snapshots_customer_feature",
        ),
        Index(
            "ix_customer_feature_snapshots_customer_as_of",
            "customer_id",
            "as_of_at",
        ),
    )

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    customer_id: Mapped[int] = mapped_column(
        BigInteger,
        ForeignKey("customers.customer_id", ondelete="CASCADE"),
        nullable=False,
    )
    feature_sha256: Mapped[str] = mapped_column(String(64), nullable=False)
    source_dataset_sha256: Mapped[str | None] = mapped_column(
        String(64),
        nullable=True,
    )
    customer_age: Mapped[int] = mapped_column(Integer, nullable=False)
    gender: Mapped[str] = mapped_column(String(1), nullable=False)
    dependent_count: Mapped[int] = mapped_column(Integer, nullable=False)
    education_level: Mapped[str] = mapped_column(String(30), nullable=False)
    marital_status: Mapped[str] = mapped_column(String(20), nullable=False)
    income_category: Mapped[str] = mapped_column(String(30), nullable=False)
    card_category: Mapped[str] = mapped_column(String(20), nullable=False)
    months_on_book: Mapped[int] = mapped_column(Integer, nullable=False)
    total_relationship_count: Mapped[int] = mapped_column(Integer, nullable=False)
    months_inactive_12_mon: Mapped[int] = mapped_column(Integer, nullable=False)
    contacts_count_12_mon: Mapped[int] = mapped_column(Integer, nullable=False)
    credit_limit: Mapped[float] = mapped_column(Float, nullable=False)
    total_revolving_bal: Mapped[int] = mapped_column(Integer, nullable=False)
    avg_open_to_buy: Mapped[float] = mapped_column(Float, nullable=False)
    total_amt_chng_q4_q1: Mapped[float] = mapped_column(Float, nullable=False)
    total_trans_amt: Mapped[int] = mapped_column(Integer, nullable=False)
    total_trans_ct: Mapped[int] = mapped_column(Integer, nullable=False)
    total_ct_chng_q4_q1: Mapped[float] = mapped_column(Float, nullable=False)
    avg_utilization_ratio: Mapped[float] = mapped_column(Float, nullable=False)
    as_of_date: Mapped[date] = mapped_column(Date, nullable=False)
    as_of_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True),
        nullable=False,
        server_default=text("CURRENT_TIMESTAMP"),
    )

    customer: Mapped[Customer] = relationship(back_populates="feature_snapshots")
    insights: Mapped[list[CustomerInsight]] = relationship(
        back_populates="customer_snapshot",
    )


class DecisionPolicy(Base):
    """분석 결과를 해석하는 위험도·활동성 정책의 immutable registry입니다."""

    __tablename__ = "decision_policies"
    __table_args__ = (
        UniqueConstraint(
            "policy_sha256",
            name="uq_decision_policies_policy_sha256",
        ),
        Index("ix_decision_policies_version_created_at", "version", "created_at"),
    )

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    version: Mapped[str] = mapped_column(String(50), nullable=False)
    policy_sha256: Mapped[str] = mapped_column(String(64), nullable=False)
    medium_threshold: Mapped[float] = mapped_column(Float, nullable=False)
    high_threshold: Mapped[float] = mapped_column(Float, nullable=False)
    activity_gap_quantile: Mapped[float] = mapped_column(Float, nullable=False)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True),
        nullable=False,
        server_default=text("CURRENT_TIMESTAMP"),
    )

    scoring_batches: Mapped[list[ScoringBatch]] = relationship(
        back_populates="decision_policy",
    )


class ScoringBatch(Base):
    """세 모델 실행과 결과를 하나로 묶는 분석 배치 실행 단위입니다."""

    __tablename__ = "scoring_batches"
    __table_args__ = (
        CheckConstraint(
            "status IN ('running', 'succeeded', 'failed')",
            name="ck_scoring_batches_status",
        ),
        UniqueConstraint(
            "batch_key_sha256",
            name="uq_scoring_batches_batch_key_sha256",
        ),
        Index("ix_scoring_batches_as_of_date", "as_of_date"),
        Index("ix_scoring_batches_status_started_at", "status", "started_at"),
    )

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    batch_key_sha256: Mapped[str] = mapped_column(String(64), nullable=False)
    as_of_date: Mapped[date] = mapped_column(Date, nullable=False)
    source_dataset_sha256: Mapped[str | None] = mapped_column(
        String(64),
        nullable=True,
    )
    dataset_sha256: Mapped[str | None] = mapped_column(String(64), nullable=True)
    decision_policy_id: Mapped[int] = mapped_column(
        Integer,
        ForeignKey("decision_policies.id", ondelete="RESTRICT"),
        nullable=False,
    )
    status: Mapped[str] = mapped_column(
        String(20),
        nullable=False,
        default=ModelRunStatus.RUNNING.value,
        server_default=ModelRunStatus.RUNNING.value,
    )
    processed_rows: Mapped[int | None] = mapped_column(Integer, nullable=True)
    error_message: Mapped[str | None] = mapped_column(Text, nullable=True)
    started_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True),
        nullable=False,
        server_default=text("CURRENT_TIMESTAMP"),
    )
    completed_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True),
        nullable=True,
    )
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True),
        nullable=False,
        server_default=text("CURRENT_TIMESTAMP"),
    )

    decision_policy: Mapped[DecisionPolicy] = relationship(
        back_populates="scoring_batches",
    )
    model_runs: Mapped[list[ModelRun]] = relationship(
        back_populates="scoring_batch",
    )
    insights: Mapped[list[CustomerInsight]] = relationship(
        back_populates="scoring_batch",
    )


class ModelRun(Base):
    """모델 산출물 버전과 배치 실행 이력을 저장합니다."""

    __tablename__ = "model_runs"
    __table_args__ = (
        CheckConstraint(
            "status IN ('running', 'succeeded', 'failed')",
            name="ck_model_runs_status",
        ),
        Index("ix_model_runs_task_started_at", "task", "started_at"),
    )

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    task: Mapped[str] = mapped_column(String(32), nullable=False)
    model_name: Mapped[str] = mapped_column(String(100), nullable=False)
    model_version: Mapped[str] = mapped_column(String(100), nullable=False)
    artifact_path: Mapped[str] = mapped_column(String(500), nullable=False)
    artifact_sha256: Mapped[str] = mapped_column(String(64), nullable=False)
    dataset_sha256: Mapped[str | None] = mapped_column(String(64), nullable=True)
    scoring_batch_id: Mapped[int | None] = mapped_column(
        Integer,
        ForeignKey("scoring_batches.id", ondelete="RESTRICT"),
        nullable=True,
    )
    decision_policy_sha256: Mapped[str | None] = mapped_column(
        String(64),
        nullable=True,
    )
    medium_threshold: Mapped[float | None] = mapped_column(Float, nullable=True)
    high_threshold: Mapped[float | None] = mapped_column(Float, nullable=True)
    activity_gap_quantile: Mapped[float | None] = mapped_column(
        Float,
        nullable=True,
    )
    status: Mapped[str] = mapped_column(
        String(20),
        nullable=False,
        default=ModelRunStatus.RUNNING.value,
        server_default=ModelRunStatus.RUNNING.value,
    )
    processed_rows: Mapped[int | None] = mapped_column(Integer, nullable=True)
    error_message: Mapped[str | None] = mapped_column(Text, nullable=True)
    started_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True),
        nullable=False,
        server_default=text("CURRENT_TIMESTAMP"),
    )
    completed_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True),
        nullable=True,
    )
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True),
        nullable=False,
        server_default=text("CURRENT_TIMESTAMP"),
    )

    scoring_batch: Mapped[ScoringBatch | None] = relationship(
        back_populates="model_runs",
    )


class CustomerInsight(Base):
    """고객별 분류·회귀·군집 통합 분석 스냅샷을 저장합니다."""

    __tablename__ = "customer_insights"
    __table_args__ = (
        CheckConstraint(
            "churn_probability BETWEEN 0 AND 1",
            name="ck_customer_insights_churn_probability",
        ),
        CheckConstraint(
            "risk_level IN ('low', 'medium', 'high')",
            name="ck_customer_insights_risk_level",
        ),
        CheckConstraint(
            "expected_transaction_count >= 0",
            name="ck_customer_insights_expected_transaction_count",
        ),
        CheckConstraint(
            "cluster_confidence IS NULL OR "
            "cluster_confidence BETWEEN 0 AND 1",
            name="ck_customer_insights_cluster_confidence",
        ),
        Index(
            "ix_customer_insights_customer_scored_at",
            "customer_id",
            "scored_at",
        ),
        Index("ix_customer_insights_risk_level", "risk_level"),
        Index("ix_customer_insights_cluster_name", "cluster_name"),
    )

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    customer_id: Mapped[int] = mapped_column(
        BigInteger,
        ForeignKey("customers.customer_id", ondelete="CASCADE"),
        nullable=False,
    )
    customer_snapshot_id: Mapped[int | None] = mapped_column(
        Integer,
        ForeignKey("customer_feature_snapshots.id", ondelete="RESTRICT"),
        nullable=True,
    )
    scoring_batch_id: Mapped[int | None] = mapped_column(
        Integer,
        ForeignKey("scoring_batches.id", ondelete="RESTRICT"),
        nullable=True,
    )
    classification_run_id: Mapped[int] = mapped_column(
        Integer,
        ForeignKey("model_runs.id", ondelete="RESTRICT"),
        nullable=False,
    )
    regression_run_id: Mapped[int] = mapped_column(
        Integer,
        ForeignKey("model_runs.id", ondelete="RESTRICT"),
        nullable=False,
    )
    clustering_run_id: Mapped[int] = mapped_column(
        Integer,
        ForeignKey("model_runs.id", ondelete="RESTRICT"),
        nullable=False,
    )
    churn_probability: Mapped[float] = mapped_column(Float, nullable=False)
    as_of_date: Mapped[date | None] = mapped_column(Date, nullable=True)
    risk_level: Mapped[str] = mapped_column(String(20), nullable=False)
    expected_transaction_count: Mapped[float] = mapped_column(Float, nullable=False)
    activity_gap: Mapped[float] = mapped_column(Float, nullable=False)
    cluster_name: Mapped[str] = mapped_column(String(100), nullable=False)
    cluster_confidence: Mapped[float | None] = mapped_column(Float, nullable=True)
    recommended_action: Mapped[str] = mapped_column(Text, nullable=False)
    reason_codes: Mapped[list[str] | dict[str, Any] | None] = mapped_column(
        JSON,
        nullable=True,
    )
    scored_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True),
        nullable=False,
        server_default=text("CURRENT_TIMESTAMP"),
    )
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True),
        nullable=False,
        server_default=text("CURRENT_TIMESTAMP"),
    )

    customer: Mapped[Customer] = relationship(back_populates="insights")
    customer_snapshot: Mapped[CustomerFeatureSnapshot | None] = relationship(
        back_populates="insights",
    )
    scoring_batch: Mapped[ScoringBatch | None] = relationship(
        back_populates="insights",
    )
    classification_run: Mapped[ModelRun] = relationship(
        foreign_keys=[classification_run_id],
    )
    regression_run: Mapped[ModelRun] = relationship(
        foreign_keys=[regression_run_id],
    )
    clustering_run: Mapped[ModelRun] = relationship(
        foreign_keys=[clustering_run_id],
    )
    campaign_targets: Mapped[list[CampaignTarget]] = relationship(
        back_populates="customer_insight",
    )


class CampaignTarget(Base):
    """추천 캠페인의 담당자, 처리 상태·일시와 결과를 저장합니다."""

    __tablename__ = "campaign_targets"
    __table_args__ = (
        CheckConstraint(
            "status IN ('pending', 'assigned', 'contacted', 'completed', 'cancelled')",
            name="ck_campaign_targets_status",
        ),
        UniqueConstraint(
            "customer_insight_id",
            "campaign_name",
            name="uq_campaign_targets_insight_campaign",
        ),
        Index("ix_campaign_targets_status", "status"),
        Index("ix_campaign_targets_assigned_to", "assigned_to_user_id"),
        Index("ix_campaign_targets_customer", "customer_id"),
    )

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    customer_id: Mapped[int] = mapped_column(
        BigInteger,
        ForeignKey("customers.customer_id", ondelete="CASCADE"),
        nullable=False,
    )
    customer_insight_id: Mapped[int] = mapped_column(
        Integer,
        ForeignKey("customer_insights.id", ondelete="RESTRICT"),
        nullable=False,
    )
    campaign_name: Mapped[str] = mapped_column(String(150), nullable=False)
    assigned_to_user_id: Mapped[int | None] = mapped_column(
        Integer,
        ForeignKey("users.id", ondelete="SET NULL"),
        nullable=True,
    )
    status: Mapped[str] = mapped_column(
        String(20),
        nullable=False,
        default=CampaignStatus.PENDING.value,
        server_default=CampaignStatus.PENDING.value,
    )
    processed_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True),
        nullable=True,
    )
    result: Mapped[str | None] = mapped_column(String(100), nullable=True)
    result_notes: Mapped[str | None] = mapped_column(Text, nullable=True)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True),
        nullable=False,
        server_default=text("CURRENT_TIMESTAMP"),
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True),
        nullable=False,
        server_default=text("CURRENT_TIMESTAMP"),
        onupdate=func.now(),
    )

    customer: Mapped[Customer] = relationship(back_populates="campaign_targets")
    customer_insight: Mapped[CustomerInsight] = relationship(
        back_populates="campaign_targets",
    )
    assignee: Mapped[User | None] = relationship(
        back_populates="assigned_campaign_targets",
        foreign_keys=[assigned_to_user_id],
    )
