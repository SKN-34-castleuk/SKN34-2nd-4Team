"""분류·회귀·군집 모델을 한 번 실행하고 고객 분석 결과를 저장합니다.

이 모듈은 온라인 예측 API와 별개인 오프라인 배치 경로입니다. 원본 고객
특성은 ``customers``에서 읽고, 세 모델의 결과를 하나의
``customer_insights`` 스냅샷으로 묶어 저장합니다. 각 스냅샷은 세 개의
``model_runs``를 참조하므로 어떤 artifact로 계산했는지 추적할 수 있습니다.
"""

from __future__ import annotations

import hashlib
import json
import os
from collections import Counter
from dataclasses import asdict, dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

import joblib
import numpy as np
import pandas as pd
from sqlalchemy import desc, func, insert, select
from sqlalchemy.orm import Session

from .config import PROJECT_ROOT, get_model_dir
from .enums import ModelRunStatus, RiskLevel
from .model_registry import ModelRegistry
from .models import Customer, CustomerFeatureSnapshot, CustomerInsight, ModelRun
from .schemas import PREDICTION_FIELD_MAP


CLASSIFICATION_TASK = "classification"
REGRESSION_TASK = "regression"
CLUSTERING_TASK = "clustering"

REGRESSION_DROP_COLUMNS = {
    "Total_Trans_Ct",
    "Total_Ct_Chng_Q4_Q1",
    "Total_Trans_Amt",
    "Target",
}
DECISION_POLICY_VERSION = "activity-gap-v2"
DEFAULT_ACTIVITY_GAP_QUANTILE = 0.2
SNAPSHOT_ATTRIBUTE_NAMES = tuple(PREDICTION_FIELD_MAP.keys())


@dataclass(frozen=True)
class BatchSummary:
    """성공한 배치의 요약 정보입니다."""

    processed_rows: int
    classification_run_id: int
    regression_run_id: int
    clustering_run_id: int
    reused_existing_snapshot: bool
    decision_policy_sha256: str
    risk_counts: dict[str, int]
    cluster_counts: dict[str, int]

    def to_dict(self) -> dict[str, Any]:
        """CLI에서 출력할 수 있는 JSON 직렬화용 딕셔너리입니다."""
        return asdict(self)


def sha256_file(path: Path) -> str:
    """파일을 메모리에 모두 올리지 않고 SHA-256을 계산합니다."""
    digest = hashlib.sha256()
    with path.open("rb") as file:
        for chunk in iter(lambda: file.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def _artifact_path(model_dir: Path, filename: str) -> Path:
    """모델 디렉터리 안의 artifact 경로를 검증해 반환합니다."""
    path = (model_dir / filename).resolve()
    root = model_dir.resolve()
    if not path.is_relative_to(root) or path.name != filename:
        raise ValueError(f"Model artifact must be a file in MODEL_DIR: {filename}")
    if not path.is_file():
        raise FileNotFoundError(f"Required model artifact not found: {path}")
    return path


def _display_path(path: Path) -> str:
    """실행 환경과 무관하게 저장할 수 있는 artifact 상대 경로를 만듭니다."""
    try:
        return str(path.resolve().relative_to(PROJECT_ROOT.resolve()))
    except ValueError:
        return str(path)


def _dataset_hash() -> str | None:
    """현재 배치의 원천 파일 해시를 반환합니다."""
    candidates = [
        Path(os.environ["DATASET_PATH"])
        if os.environ.get("DATASET_PATH")
        else None,
        PROJECT_ROOT / "data" / "processed" / "bankchurners_clean.csv",
    ]
    for candidate in candidates:
        if candidate is not None and candidate.is_file():
            return sha256_file(candidate)
    return None


def _customer_feature_values(customer: Customer) -> dict[str, Any]:
    """고객 ORM 객체에서 모델 입력에 해당하는 snake_case 값을 추출합니다."""
    return {
        attribute: getattr(customer, attribute)
        for attribute in SNAPSHOT_ATTRIBUTE_NAMES
    }


def _canonical_json(value: dict[str, Any]) -> bytes:
    """정책·특성 해시가 실행 환경에 따라 달라지지 않게 직렬화합니다."""
    return json.dumps(
        value,
        ensure_ascii=False,
        sort_keys=True,
        separators=(",", ":"),
    ).encode("utf-8")


def _feature_sha256(values: dict[str, Any]) -> str:
    """고객 입력 특성 한 행의 SHA-256을 반환합니다."""
    return hashlib.sha256(_canonical_json(values)).hexdigest()


def _customer_dataset_hash(customers: list[Customer]) -> str:
    """현재 DB 고객 특성 전체의 정렬·정규화된 해시를 반환합니다."""
    digest = hashlib.sha256()
    for customer in customers:
        digest.update(str(customer.customer_id).encode("ascii"))
        digest.update(b"\0")
        digest.update(_canonical_json(_customer_feature_values(customer)))
        digest.update(b"\n")
    return digest.hexdigest()


def _decision_policy_sha256(
    *,
    medium_threshold: float,
    high_threshold: float,
    activity_gap_quantile: float,
) -> str:
    """위험도와 추천 액션 정책의 버전을 해시합니다."""
    return hashlib.sha256(
        _canonical_json(
            {
                "version": DECISION_POLICY_VERSION,
                "medium_threshold": medium_threshold,
                "high_threshold": high_threshold,
                "activity_gap_quantile": activity_gap_quantile,
            }
        )
    ).hexdigest()


def _ensure_feature_snapshots(
    session: Session,
    customers: list[Customer],
    *,
    source_dataset_sha256: str | None,
    as_of_at: datetime,
) -> list[CustomerFeatureSnapshot]:
    """현재 고객 특성을 재현 가능한 스냅샷으로 만들고 고객 순서를 보존합니다."""
    customer_ids = [customer.customer_id for customer in customers]
    existing = session.scalars(
        select(CustomerFeatureSnapshot).where(
            CustomerFeatureSnapshot.customer_id.in_(customer_ids)
        )
    ).all()
    existing_by_key = {
        (snapshot.customer_id, snapshot.feature_sha256): snapshot
        for snapshot in existing
    }

    snapshots: list[CustomerFeatureSnapshot] = []
    for customer in customers:
        values = _customer_feature_values(customer)
        feature_sha256 = _feature_sha256(values)
        snapshot = existing_by_key.get((customer.customer_id, feature_sha256))
        if snapshot is None:
            snapshot = CustomerFeatureSnapshot(
                customer_id=customer.customer_id,
                feature_sha256=feature_sha256,
                source_dataset_sha256=source_dataset_sha256,
                as_of_at=as_of_at,
                **values,
            )
            session.add(snapshot)
        snapshots.append(snapshot)

    session.flush()
    return snapshots


def _customer_frame(customers: list[Customer]) -> tuple[pd.DataFrame, pd.Series]:
    """ORM 고객 목록을 모델 원본 컬럼명을 가진 DataFrame으로 변환합니다."""
    records: list[dict[str, Any]] = []
    customer_ids: list[int] = []
    for customer in customers:
        customer_ids.append(int(customer.customer_id))
        records.append(
            {
                model_field: getattr(customer, request_field)
                for request_field, model_field in PREDICTION_FIELD_MAP.items()
            }
        )
    return pd.DataFrame(records), pd.Series(customer_ids, name="customer_id")


def build_regression_input(raw_features: pd.DataFrame) -> pd.DataFrame:
    """최종 회귀 artifact와 동일한 파생변수·누수 제거 규칙을 적용합니다."""
    data = raw_features.copy()
    data["리볼빙_한도_비율"] = (
        data["Total_Revolving_Bal"] / data["Credit_Limit"]
    )
    data["상품당_관계밀도"] = (
        data["Total_Relationship_Count"] / data["Months_on_book"]
    )
    data["문의_대비_보유기간"] = (
        data["Contacts_Count_12_mon"] / data["Months_on_book"]
    )
    data["연령대"] = pd.cut(
        data["Customer_Age"],
        bins=[0, 30, 40, 50, 60, 100],
        labels=["20대이하", "30대", "40대", "50대", "60대이상"],
    )
    return data.drop(
        columns=[column for column in REGRESSION_DROP_COLUMNS if column in data]
    )


def _cluster_label_map(artifact: dict[str, Any]) -> dict[int, str]:
    """활동성 갭 평균을 기준으로 GMM 군집에 업무 라벨을 붙입니다."""
    model = artifact["model"]
    scaler = artifact["scaler"]
    if hasattr(model, "means_"):
        means = scaler.inverse_transform(np.asarray(model.means_))
        gap_means = means[:, 0]
    elif hasattr(model, "cluster_centers_"):
        centers = scaler.inverse_transform(np.asarray(model.cluster_centers_))
        gap_means = centers[:, 0]
    else:
        return {}

    ordered = np.argsort(gap_means)
    labels = {int(ordered[0]): "우선케어(거래 감소)"}
    if len(ordered) > 1:
        labels[int(ordered[-1])] = "우량(예상이상)"
    for cluster_id in ordered[1:-1]:
        labels[int(cluster_id)] = "일반관리(유지)"
    return labels


def _risk_level(probability: float, medium_threshold: float, high_threshold: float) -> str:
    """운영용 이탈 확률 구간을 반환합니다."""
    if probability >= high_threshold:
        return RiskLevel.HIGH.value
    if probability >= medium_threshold:
        return RiskLevel.MEDIUM.value
    return RiskLevel.LOW.value


def _reason_codes(
    row: pd.Series,
    *,
    transaction_count_median: float,
    count_change_median: float,
    activity_gap: float,
    activity_gap_priority_threshold: float,
) -> list[str]:
    """원본 특성 및 활동성 갭으로 설명 가능한 운영 사유 코드를 만듭니다."""
    reasons: list[str] = []
    if float(row["Total_Trans_Ct"]) <= transaction_count_median:
        reasons.append("low_transaction_activity")
    if float(row["Total_Ct_Chng_Q4_Q1"]) <= min(count_change_median, 0.7):
        reasons.append("transaction_decline")
    if float(row["Months_Inactive_12_mon"]) >= 3:
        reasons.append("long_inactivity")
    if float(row["Contacts_Count_12_mon"]) >= 3:
        reasons.append("frequent_contacts")
    if float(row["Total_Relationship_Count"]) <= 2:
        reasons.append("low_relationship_count")
    if activity_gap <= activity_gap_priority_threshold:
        reasons.append("priority_activity_gap")
    elif activity_gap < 0:
        reasons.append("below_expected_activity")
    return reasons or ["stable_activity"]


def _recommended_action(
    risk_level: str,
    activity_gap: float,
    cluster_name: str,
    *,
    activity_gap_priority_threshold: float = 0.0,
) -> str:
    """분석 결과를 운영 담당자가 바로 사용할 수 있는 액션 문구로 변환합니다."""
    if risk_level == RiskLevel.HIGH.value and activity_gap < 0:
        return "이탈 위험 우선 상담 및 거래 활성화 혜택"
    if risk_level == RiskLevel.HIGH.value:
        return "이탈 위험 고객 상담 및 관계 유지"
    if activity_gap <= activity_gap_priority_threshold:
        return "저활동 고객 재활성화 캠페인"
    if cluster_name == "우량(예상이상)" and risk_level == RiskLevel.LOW.value:
        return "우량 고객 업셀링 검토"
    return "일반 유지 관리"


def _latest_succeeded_run(session: Session, task: str) -> ModelRun | None:
    return session.scalar(
        select(ModelRun)
        .where(
            ModelRun.task == task,
            ModelRun.status == ModelRunStatus.SUCCEEDED.value,
        )
        .order_by(desc(ModelRun.completed_at), desc(ModelRun.id))
        .limit(1)
    )


def _reusable_snapshot(
    session: Session,
    *,
    processed_rows: int,
    dataset_sha256: str | None,
    decision_policy_sha256: str,
    run_specs: list[dict[str, Any]],
) -> BatchSummary | None:
    """동일 데이터·artifact로 이미 완성된 스냅샷이면 재사용합니다."""
    latest = {
        spec["task"]: _latest_succeeded_run(session, spec["task"])
        for spec in run_specs
    }
    if any(latest[spec["task"]] is None for spec in run_specs):
        return None
    for spec in run_specs:
        run = latest[spec["task"]]
        assert run is not None
        if (
            run.artifact_sha256 != spec["artifact_sha256"]
            or run.dataset_sha256 != dataset_sha256
            or run.decision_policy_sha256 != decision_policy_sha256
        ):
            return None

    classification = latest[CLASSIFICATION_TASK]
    regression = latest[REGRESSION_TASK]
    clustering = latest[CLUSTERING_TASK]
    assert classification is not None
    assert regression is not None
    assert clustering is not None
    count = session.scalar(
        select(func.count())
        .select_from(CustomerInsight)
        .where(
            CustomerInsight.classification_run_id == classification.id,
            CustomerInsight.regression_run_id == regression.id,
            CustomerInsight.clustering_run_id == clustering.id,
        )
    )
    if int(count or 0) != processed_rows:
        return None

    risk_counts = dict(
        session.execute(
            select(CustomerInsight.risk_level, func.count())
            .where(
                CustomerInsight.classification_run_id == classification.id,
                CustomerInsight.regression_run_id == regression.id,
                CustomerInsight.clustering_run_id == clustering.id,
            )
            .group_by(CustomerInsight.risk_level)
        ).all()
    )
    cluster_counts = dict(
        session.execute(
            select(CustomerInsight.cluster_name, func.count())
            .where(
                CustomerInsight.classification_run_id == classification.id,
                CustomerInsight.regression_run_id == regression.id,
                CustomerInsight.clustering_run_id == clustering.id,
            )
            .group_by(CustomerInsight.cluster_name)
        ).all()
    )
    return BatchSummary(
        processed_rows=processed_rows,
        classification_run_id=classification.id,
        regression_run_id=regression.id,
        clustering_run_id=clustering.id,
        reused_existing_snapshot=True,
        decision_policy_sha256=decision_policy_sha256,
        risk_counts={str(key): int(value) for key, value in risk_counts.items()},
        cluster_counts={str(key): int(value) for key, value in cluster_counts.items()},
    )


def run_batch(
    session: Session,
    *,
    model_dir: Path | None = None,
    medium_threshold: float = 0.5,
    high_threshold: float = 0.85,
    activity_gap_quantile: float = DEFAULT_ACTIVITY_GAP_QUANTILE,
    force: bool = False,
) -> BatchSummary:
    """세 모델을 실행하고 고객별 분석 스냅샷을 MySQL에 저장합니다."""
    if not 0.0 <= medium_threshold < high_threshold <= 1.0:
        raise ValueError("Thresholds must satisfy 0 <= medium < high <= 1.")
    if not 0.0 < activity_gap_quantile < 1.0:
        raise ValueError("activity_gap_quantile must satisfy 0 < quantile < 1.")

    customers = list(
        session.scalars(select(Customer).order_by(Customer.customer_id)).all()
    )
    if not customers:
        raise ValueError("No customers found. Import customers before scoring.")

    source_dataset_sha256 = _dataset_hash()
    dataset_sha256 = _customer_dataset_hash(customers)
    decision_policy_sha256 = _decision_policy_sha256(
        medium_threshold=medium_threshold,
        high_threshold=high_threshold,
        activity_gap_quantile=activity_gap_quantile,
    )

    model_root = (model_dir or get_model_dir()).resolve()
    raw_features, customer_ids = _customer_frame(customers)

    # 1) 분류: 온라인 API와 같은 manifest 검증·기본 모델을 사용합니다.
    registry = ModelRegistry(model_root)
    registry.load()
    classification_result = registry.predict_batch(raw_features)
    classification_artifact = _artifact_path(
        model_root, registry.default_model.artifact
    )
    assert registry.manifest is not None

    # 2) 회귀: 저장된 Voting pipeline으로 기대 거래건수를 계산합니다.
    regression_artifact = _artifact_path(model_root, "regression_model.joblib")
    regression_model = joblib.load(regression_artifact)
    regression_input = build_regression_input(raw_features)
    expected_transactions = np.maximum(
        np.asarray(regression_model.predict(regression_input), dtype="float64"),
        0.0,
    )
    actual_transactions = raw_features["Total_Trans_Ct"].to_numpy(dtype="float64")
    activity_gap = actual_transactions - expected_transactions

    # 3) 군집: regression_final과 함께 생성된 activity-gap GMM을 사용합니다.
    clustering_artifact = _artifact_path(
        model_root, "clustering_activity_gap.joblib"
    )
    clustering_bundle = joblib.load(clustering_artifact)
    cluster_features = list(clustering_bundle["features"])
    cluster_input = pd.DataFrame(
        {
            "예상_대비_거래_차이": activity_gap,
            "실제_거래건수": actual_transactions,
        }
    )
    if cluster_features != list(cluster_input.columns):
        raise ValueError(
            "Activity-gap clustering artifact features do not match the batch input."
        )
    scaled_cluster_input = clustering_bundle["scaler"].transform(
        cluster_input[cluster_features]
    )
    cluster_model = clustering_bundle["model"]
    cluster_ids = np.asarray(cluster_model.predict(scaled_cluster_input), dtype=int)
    if callable(getattr(cluster_model, "predict_proba", None)):
        cluster_confidence = np.asarray(
            cluster_model.predict_proba(scaled_cluster_input).max(axis=1),
            dtype="float64",
        )
    else:
        cluster_confidence = np.full(len(customers), np.nan, dtype="float64")
    cluster_labels = _cluster_label_map(clustering_bundle)
    cluster_names = [
        cluster_labels.get(int(cluster_id), f"군집-{int(cluster_id)}")
        for cluster_id in cluster_ids
    ]

    activity_gap_priority_threshold = float(
        np.quantile(activity_gap, activity_gap_quantile)
    )

    run_specs = [
        {
            "task": CLASSIFICATION_TASK,
            "model_name": registry.default_model.name,
            "model_version": registry.manifest.generated_at.isoformat(),
            "artifact_path": _display_path(classification_artifact),
            "artifact_sha256": registry.default_model.sha256,
            "decision_policy_sha256": decision_policy_sha256,
        },
        {
            "task": REGRESSION_TASK,
            "model_name": "Voting",
            "model_version": sha256_file(regression_artifact),
            "artifact_path": _display_path(regression_artifact),
            "artifact_sha256": sha256_file(regression_artifact),
            "decision_policy_sha256": decision_policy_sha256,
        },
        {
            "task": CLUSTERING_TASK,
            "model_name": "GMM(spherical) activity_gap",
            "model_version": sha256_file(clustering_artifact),
            "artifact_path": _display_path(clustering_artifact),
            "artifact_sha256": sha256_file(clustering_artifact),
            "decision_policy_sha256": decision_policy_sha256,
        },
    ]

    if not force:
        reusable = _reusable_snapshot(
            session,
            processed_rows=len(customers),
            dataset_sha256=dataset_sha256,
            decision_policy_sha256=decision_policy_sha256,
            run_specs=run_specs,
        )
        if reusable is not None:
            return reusable

    now = datetime.now(timezone.utc)
    runs = [
        ModelRun(
            task=spec["task"],
            model_name=spec["model_name"],
            model_version=spec["model_version"],
            artifact_path=spec["artifact_path"],
            artifact_sha256=spec["artifact_sha256"],
            dataset_sha256=dataset_sha256,
            decision_policy_sha256=decision_policy_sha256,
            medium_threshold=medium_threshold,
            high_threshold=high_threshold,
            activity_gap_quantile=activity_gap_quantile,
            status=ModelRunStatus.RUNNING.value,
            processed_rows=None,
            started_at=now,
        )
        for spec in run_specs
    ]
    session.add_all(runs)
    session.commit()

    snapshots = _ensure_feature_snapshots(
        session,
        customers,
        source_dataset_sha256=source_dataset_sha256,
        as_of_at=now,
    )

    transaction_count_median = float(raw_features["Total_Trans_Ct"].median())
    count_change_median = float(raw_features["Total_Ct_Chng_Q4_Q1"].median())
    insight_records: list[dict[str, Any]] = []
    for index, row in raw_features.iterrows():
        probability = float(classification_result.iloc[index]["churn_probability"])
        gap = float(activity_gap[index])
        risk = _risk_level(probability, medium_threshold, high_threshold)
        cluster_name = cluster_names[index]
        reasons = _reason_codes(
            row,
            transaction_count_median=transaction_count_median,
            count_change_median=count_change_median,
            activity_gap=gap,
            activity_gap_priority_threshold=activity_gap_priority_threshold,
        )
        insight_records.append(
            {
                "customer_id": int(customer_ids.iloc[index]),
                "customer_snapshot_id": snapshots[index].id,
                "classification_run_id": runs[0].id,
                "regression_run_id": runs[1].id,
                "clustering_run_id": runs[2].id,
                "churn_probability": probability,
                "risk_level": risk,
                "expected_transaction_count": float(expected_transactions[index]),
                "activity_gap": gap,
                "cluster_name": cluster_name,
                "cluster_confidence": float(cluster_confidence[index])
                if np.isfinite(cluster_confidence[index])
                else None,
                "recommended_action": _recommended_action(
                    risk,
                    gap,
                    cluster_name,
                    activity_gap_priority_threshold=activity_gap_priority_threshold,
                ),
                "reason_codes": reasons,
                "scored_at": now,
            }
        )

    try:
        session.execute(insert(CustomerInsight), insight_records)
        completed_at = datetime.now(timezone.utc)
        for run in runs:
            run.status = ModelRunStatus.SUCCEEDED.value
            run.processed_rows = len(customers)
            run.completed_at = completed_at
        session.commit()
    except Exception as exc:
        session.rollback()
        failed_runs = list(
            session.scalars(select(ModelRun).where(ModelRun.id.in_([run.id for run in runs]))).all()
        )
        for run in failed_runs:
            run.status = ModelRunStatus.FAILED.value
            run.error_message = str(exc)[:4000]
            run.completed_at = datetime.now(timezone.utc)
        session.commit()
        raise

    return BatchSummary(
        processed_rows=len(customers),
        classification_run_id=runs[0].id,
        regression_run_id=runs[1].id,
        clustering_run_id=runs[2].id,
        reused_existing_snapshot=False,
        decision_policy_sha256=decision_policy_sha256,
        risk_counts=dict(Counter(record["risk_level"] for record in insight_records)),
        cluster_counts=dict(Counter(record["cluster_name"] for record in insight_records)),
    )
