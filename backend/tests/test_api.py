"""로컬 학습 산출물 없이 API와 모델 레지스트리를 검증하는 테스트입니다."""

from __future__ import annotations

import hashlib
import json
import shutil
from collections.abc import Iterator
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

import joblib
import pandas as pd
import pytest
from fastapi.testclient import TestClient
from sqlalchemy import select

from backend.app.main import create_app
from backend.app.migration_runner import upgrade_database
from backend.app.customer_import import load_customer_rows
from backend.app.enums import CampaignStatus, ModelRunStatus, RiskLevel, UserRole
from backend.app.model_registry import ModelLoadError, ModelRegistry
from backend.app.models import Customer, CustomerInsight, ModelRun, User
from backend.app.schemas import PREDICTION_FIELD_MAP


class FakeClassifier:
    """모델 적재 테스트에만 사용하는 최소한의 직렬화 가능 분류기입니다."""

    classes_ = [0, 1]

    def predict(self, values: Any) -> list[int]:
        """예측 확률을 0.5 기준으로 이진 클래스 값으로 변환합니다."""
        return [
            int(probabilities[1] >= 0.5)
            for probabilities in self.predict_proba(values)
        ]

    def predict_proba(self, values: Any) -> list[list[float]]:
        """나이가 60세 이상인 테스트 입력에 높은 이탈 확률을 반환합니다."""
        return [
            [0.1, 0.9] if age >= 60 else [0.9, 0.1]
            for age in values["Customer_Age"]
        ]


# API 성공 요청과 입력 검증 테스트에서 공통으로 사용하는 고객 예시입니다.
VALID_PREDICTION_PAYLOAD = {
    "customer_age": 45,
    "gender": "F",
    "dependent_count": 2,
    "education_level": "Graduate",
    "marital_status": "Married",
    "income_category": "$40K - $60K",
    "card_category": "Blue",
    "months_on_book": 36,
    "total_relationship_count": 4,
    "months_inactive_12_mon": 2,
    "contacts_count_12_mon": 3,
    "credit_limit": 12000.0,
    "total_revolving_bal": 1500,
    "avg_open_to_buy": 10500.0,
    "total_amt_chng_q4_q1": 0.8,
    "total_trans_amt": 4500,
    "total_trans_ct": 70,
    "total_ct_chng_q4_q1": 0.75,
    "avg_utilization_ratio": 0.25,
}


def sha256(path: Path) -> str:
    """테스트용 모델 파일의 SHA-256 해시를 계산합니다."""
    return hashlib.sha256(path.read_bytes()).hexdigest()


def make_feature_manifest() -> list[dict[str, Any]]:
    """유효한 API 요청과 일치하는 테스트용 특성 manifest를 생성합니다."""
    features = []
    for request_field, model_field in PREDICTION_FIELD_MAP.items():
        value = VALID_PREDICTION_PAYLOAD[request_field]
        if isinstance(value, str):
            features.append(
                {
                    "name": model_field,
                    "type": "string",
                    "required": True,
                    "allowed_values": [value],
                }
            )
        elif isinstance(value, int):
            features.append(
                {
                    "name": model_field,
                    "type": "integer",
                    "required": True,
                    "minimum": 0,
                    "maximum": max(value, 1),
                }
            )
        else:
            features.append(
                {
                    "name": model_field,
                    "type": "number",
                    "required": True,
                    "minimum": 0.0,
                    "maximum": max(value, 1.0),
                }
            )
    return features


def make_manifest(artifact_path: Path) -> dict[str, Any]:
    """지정한 모델 파일을 참조하는 완전한 테스트 manifest를 생성합니다."""
    return {
        "schema_version": 1,
        "task": "binary_classification",
        "target": {
            "name": "Target",
            "negative_class": {
                "value": 0,
                "label": "Existing Customer",
            },
            "positive_class": {
                "value": 1,
                "label": "Attrited Customer",
            },
        },
        "default_model": {
            "name": "xgboost",
            "artifact": artifact_path.name,
            "sha256": sha256(artifact_path),
            "size_bytes": artifact_path.stat().st_size,
            "decision_threshold": 0.5,
        },
        "dataset": {
            "path": "data/processed/test.csv",
            "sha256": "0" * 64,
            "rows": 10,
            "train_rows": 8,
            "test_rows": 2,
            "test_size": 0.2,
            "random_state": 42,
        },
        "test_metrics": {
            "logistic_regression": {
                "accuracy": 0.8,
                "precision": 0.7,
                "recall": 0.6,
                "f1": 0.64,
                "roc_auc": 0.82,
            },
            "random_forest": {
                "accuracy": 0.85,
                "precision": 0.8,
                "recall": 0.75,
                "f1": 0.77,
                "roc_auc": 0.9,
            },
            "xgboost": {
                "accuracy": 0.9,
                "precision": 0.88,
                "recall": 0.9,
                "f1": 0.89,
                "roc_auc": 0.95,
            },
        },
        "features": make_feature_manifest(),
        "runtime": {
            "python": "3.12.13",
            "scikit_learn": "1.9.0",
        },
        "generated_at": "2026-07-30T12:00:00+09:00",
    }


def write_manifest(model_dir: Path, manifest: dict[str, Any]) -> None:
    """테스트 manifest를 모델 디렉터리에 UTF-8 JSON으로 저장합니다."""
    (model_dir / "classification_manifest.json").write_text(
        json.dumps(manifest),
        encoding="utf-8",
    )


@pytest.fixture(scope="module")
def model_dir(tmp_path_factory: pytest.TempPathFactory) -> Path:
    """가짜 분류기와 유효한 manifest가 있는 임시 모델 디렉터리입니다."""
    directory = tmp_path_factory.mktemp("models")
    artifact_path = directory / "classification_xgboost.joblib"
    joblib.dump(FakeClassifier(), artifact_path)
    write_manifest(directory, make_manifest(artifact_path))
    return directory


@pytest.fixture(scope="module")
def client(model_dir: Path) -> Iterator[TestClient]:
    """테스트 모델을 적재한 FastAPI TestClient를 제공합니다."""
    with TestClient(
        create_app(model_dir=model_dir, database_url="", jwt_secret="")
    ) as test_client:
        yield test_client


@pytest.fixture(scope="module")
def auth_client(
    model_dir: Path,
    tmp_path_factory: pytest.TempPathFactory,
) -> Iterator[TestClient]:
    """SQLite 임시 DB를 사용하는 인증 API TestClient를 제공합니다."""
    database_path = tmp_path_factory.mktemp("auth") / "auth.sqlite3"
    database_url = f"sqlite:///{database_path}"
    upgrade_database(database_url)
    with TestClient(
        create_app(
            model_dir=model_dir,
            database_url=database_url,
            jwt_secret="test-jwt-secret-for-authentication-tests",
        )
    ) as test_client:
        yield test_client


def test_liveness_does_not_expose_model_state(client: TestClient) -> None:
    """생존 확인 응답이 모델의 내부 상태를 노출하지 않는지 확인합니다."""
    response = client.get("/live")

    assert response.status_code == 200
    assert response.json()["status"] == "ok"
    assert "model_loaded" not in response.json()


def test_readiness_reports_loaded_xgboost(client: TestClient) -> None:
    """준비 확인 응답이 적재된 기본 모델 정보를 반환하는지 확인합니다."""
    response = client.get("/ready")

    assert response.status_code == 200
    payload = response.json()
    assert payload["status"] == "ok"
    assert payload["model_loaded"] is True
    assert payload["model_name"] == "xgboost"
    assert payload["model_artifact"] == "classification_xgboost.joblib"


@pytest.mark.parametrize("path", ["/", "/health", "/api/v1/models"])
def test_removed_routes_return_not_found(
    client: TestClient,
    path: str,
) -> None:
    """제거하기로 한 불필요한 경로가 404를 반환하는지 확인합니다."""
    response = client.get(path)

    assert response.status_code == 404


def test_prediction_returns_existing_customer(client: TestClient) -> None:
    """낮은 이탈 확률 입력이 기존 고객으로 판정되는지 확인합니다."""
    response = client.post(
        "/api/v1/predictions",
        json=VALID_PREDICTION_PAYLOAD,
    )

    assert response.status_code == 200
    assert response.json() == {
        "prediction": 0,
        "status": "Existing Customer",
        "churn_probability": pytest.approx(0.1),
        "decision_threshold": 0.5,
        "model_name": "xgboost",
        "model_version": "2026-07-30T12:00:00+09:00",
    }


def test_prediction_returns_attrited_customer(client: TestClient) -> None:
    """높은 이탈 확률 입력이 이탈 고객으로 판정되는지 확인합니다."""
    payload = {**VALID_PREDICTION_PAYLOAD, "customer_age": 65}
    response = client.post("/api/v1/predictions", json=payload)

    assert response.status_code == 200
    assert response.json()["prediction"] == 1
    assert response.json()["status"] == "Attrited Customer"
    assert response.json()["churn_probability"] == pytest.approx(0.9)


def test_model_registry_predicts_a_batch(model_dir: Path) -> None:
    """배치 경로도 온라인 경로와 같은 양성 확률·임계값을 사용하는지 확인합니다."""
    registry = ModelRegistry(model_dir)
    registry.load()
    first = {
        model_field: VALID_PREDICTION_PAYLOAD[request_field]
        for request_field, model_field in PREDICTION_FIELD_MAP.items()
    }
    second = {**first, "Customer_Age": 65}

    result = registry.predict_batch(pd.DataFrame([first, second]))

    assert list(result["prediction"]) == [0, 1]
    assert list(result["churn_probability"]) == [pytest.approx(0.1), pytest.approx(0.9)]


@pytest.mark.parametrize(
    ("field", "value"),
    [
        ("customer_age", 25),
        ("gender", "X"),
        ("avg_utilization_ratio", 1.1),
    ],
)
def test_prediction_rejects_invalid_values(
    client: TestClient,
    field: str,
    value: Any,
) -> None:
    """허용 범위나 선택지를 벗어난 입력이 422로 거부되는지 확인합니다."""
    payload = {**VALID_PREDICTION_PAYLOAD, field: value}

    response = client.post("/api/v1/predictions", json=payload)

    assert response.status_code == 422


def test_prediction_rejects_missing_and_extra_fields(
    client: TestClient,
) -> None:
    """필수 필드 누락과 정의되지 않은 추가 필드가 거부되는지 확인합니다."""
    missing_payload = VALID_PREDICTION_PAYLOAD.copy()
    missing_payload.pop("customer_age")
    extra_payload = {**VALID_PREDICTION_PAYLOAD, "unknown_field": 1}

    assert (
        client.post(
            "/api/v1/predictions",
            json=missing_payload,
        ).status_code
        == 422
    )
    assert (
        client.post(
            "/api/v1/predictions",
            json=extra_payload,
        ).status_code
        == 422
    )


def test_signup_login_me_and_logout(auth_client: TestClient) -> None:
    """회원가입부터 로그인, 현재 사용자 조회, 로그아웃까지 검증합니다."""
    signup_response = auth_client.post(
        "/api/v1/auth/signup",
        json={
            "username": "Analysis_Team",
            "display_name": "분석팀",
            "password": "strong-password-123",
        },
    )

    assert signup_response.status_code == 201
    assert signup_response.json()["user"]["username"] == "analysis_team"
    assert signup_response.json()["user"]["role"] == "analyst"
    assert "password" not in signup_response.json()["user"]

    session_factory = auth_client.app.state.session_factory
    assert session_factory is not None
    with session_factory() as session:
        pending_user = session.scalar(
            select(User).where(User.username == "analysis_team")
        )
        assert pending_user is not None
        assert pending_user.is_active is False

    duplicate_response = auth_client.post(
        "/api/v1/auth/signup",
        json={
            "username": "analysis_team",
            "display_name": "중복팀",
            "password": "strong-password-123",
        },
    )
    assert duplicate_response.status_code == 409

    invalid_login_response = auth_client.post(
        "/api/v1/auth/login",
        json={
            "username": "analysis_team",
            "password": "wrong-password",
        },
    )
    assert invalid_login_response.status_code == 401

    with session_factory() as session:
        pending_user = session.scalar(
            select(User).where(User.username == "analysis_team")
        )
        assert pending_user is not None
        pending_user.is_active = True
        session.commit()

    login_response = auth_client.post(
        "/api/v1/auth/login",
        json={
            "username": "ANALYSIS_TEAM",
            "password": "strong-password-123",
            "remember_me": True,
        },
    )
    assert login_response.status_code == 200
    assert "cardops_access_token" in login_response.headers["set-cookie"]

    current_user_response = auth_client.get("/api/v1/auth/me")
    assert current_user_response.status_code == 200
    assert current_user_response.json()["display_name"] == "분석팀"

    logout_response = auth_client.post("/api/v1/auth/logout")
    assert logout_response.status_code == 204
    assert auth_client.get("/api/v1/auth/me").status_code == 401


def test_customer_insight_list_filters_and_detail(
    auth_client: TestClient,
) -> None:
    """인증, 최신 스냅샷 선택, 필터·페이지네이션·상세 조회를 검증합니다."""
    assert (
        auth_client.get("/api/v1/customer-insights").status_code == 401
    )
    signup_response = auth_client.post(
        "/api/v1/auth/signup",
        json={
            "username": "insight_viewer",
            "display_name": "인사이트 조회자",
            "password": "strong-password-123",
        },
    )
    assert signup_response.status_code == 201
    session_factory = auth_client.app.state.session_factory
    assert session_factory is not None
    with session_factory() as session:
        viewer = session.scalar(
            select(User).where(User.username == "insight_viewer")
        )
        assert viewer is not None
        viewer.is_active = True
        viewer.role = UserRole.OPERATIONS.value
        session.commit()
    assert (
        auth_client.post(
            "/api/v1/auth/login",
            json={
                "username": "insight_viewer",
                "password": "strong-password-123",
            },
        ).status_code
        == 200
    )

    raw_rows = load_customer_rows(
        Path(__file__).resolve().parents[2]
        / "data"
        / "raw"
        / "BankChurners.csv"
    )[:2]
    with session_factory() as session:
        customers = [Customer(**row) for row in raw_rows]
        runs = [
            ModelRun(
                task=task,
                model_name=name,
                model_version="test-v1",
                artifact_path=f"outputs/models/{name}.joblib",
                artifact_sha256=character * 64,
                status=ModelRunStatus.SUCCEEDED.value,
                processed_rows=2,
            )
            for task, name, character in [
                ("classification", "xgboost", "a"),
                ("regression", "voting", "b"),
                ("clustering", "activity-gap-gmm", "c"),
            ]
        ]
        session.add_all([*customers, *runs])
        session.flush()
        old_insight = CustomerInsight(
            customer_id=customers[0].customer_id,
            classification_run_id=runs[0].id,
            regression_run_id=runs[1].id,
            clustering_run_id=runs[2].id,
            churn_probability=0.95,
            risk_level=RiskLevel.HIGH.value,
            expected_transaction_count=40.0,
            activity_gap=-20.0,
            cluster_name="우선케어(거래 감소)",
            cluster_confidence=0.8,
            recommended_action="이전 결과",
            reason_codes=["old_snapshot"],
            scored_at=datetime(2026, 1, 1, tzinfo=timezone.utc),
        )
        latest_insight = CustomerInsight(
            customer_id=customers[0].customer_id,
            classification_run_id=runs[0].id,
            regression_run_id=runs[1].id,
            clustering_run_id=runs[2].id,
            churn_probability=0.2,
            risk_level=RiskLevel.LOW.value,
            expected_transaction_count=70.0,
            activity_gap=5.0,
            cluster_name="일반관리(유지)",
            cluster_confidence=0.7,
            recommended_action="일반 유지 관리",
            reason_codes=["stable_activity"],
            scored_at=datetime(2026, 2, 1, tzinfo=timezone.utc),
        )
        second_customer_insight = CustomerInsight(
            customer_id=customers[1].customer_id,
            classification_run_id=runs[0].id,
            regression_run_id=runs[1].id,
            clustering_run_id=runs[2].id,
            churn_probability=0.9,
            risk_level=RiskLevel.HIGH.value,
            expected_transaction_count=35.0,
            activity_gap=-25.0,
            cluster_name="우선케어(거래 감소)",
            cluster_confidence=0.9,
            recommended_action="이탈 위험 우선 상담 및 거래 활성화 혜택",
            reason_codes=["below_expected_activity"],
            scored_at=datetime(2026, 2, 1, tzinfo=timezone.utc),
        )
        session.add_all([old_insight, latest_insight, second_customer_insight])
        session.commit()
        latest_insight_id = latest_insight.id

    response = auth_client.get(
        "/api/v1/customer-insights",
        params={"page": 1, "page_size": 1},
    )
    assert response.status_code == 200
    payload = response.json()
    assert payload["total"] == 2
    assert payload["total_pages"] == 2
    assert payload["items"][0]["churn_probability"] == 0.9
    assert payload["stats"]["risk_counts"] == {"high": 1, "low": 1}

    filtered_response = auth_client.get(
        "/api/v1/customer-insights",
        params={"risk_level": "high", "page_size": 100},
    )
    assert filtered_response.status_code == 200
    assert filtered_response.json()["total"] == 1

    customer_id = raw_rows[0]["customer_id"]
    detail_response = auth_client.get(
        f"/api/v1/customer-insights/{customer_id}"
    )
    assert detail_response.status_code == 200
    detail = detail_response.json()
    assert detail["risk_level"] == "low"
    assert detail["recommended_action"] == "일반 유지 관리"
    assert detail["customer"]["customer_id"] == customer_id

    missing_response = auth_client.get("/api/v1/customer-insights/999999999")
    assert missing_response.status_code == 404

    history_response = auth_client.get(
        f"/api/v1/customer-insights/history/{customer_id}",
    )
    assert history_response.status_code == 200
    history = history_response.json()
    assert history["customer_id"] == customer_id
    assert len(history["items"]) == 2
    assert history["items"][0]["churn_probability"] == 0.2

    latest_batch_response = auth_client.get("/api/v1/model-runs/latest")
    assert latest_batch_response.status_code == 200
    latest_batch = latest_batch_response.json()
    assert latest_batch["status"] == "succeeded"
    assert latest_batch["processed_rows"] == 2
    assert {run["task"] for run in latest_batch["runs"]} == {
        "classification",
        "regression",
        "clustering",
    }

    campaign_response = auth_client.post(
        "/api/v1/campaign-targets",
        json={
            "customer_insight_id": latest_insight_id,
            "campaign_name": "이탈 위험 리텐션",
        },
    )
    assert campaign_response.status_code == 201
    campaign = campaign_response.json()
    assert campaign["status"] == CampaignStatus.PENDING.value
    assert campaign["customer_id"] == customer_id

    duplicate_campaign_response = auth_client.post(
        "/api/v1/campaign-targets",
        json={
            "customer_insight_id": latest_insight_id,
            "campaign_name": "이탈 위험 리텐션",
        },
    )
    assert duplicate_campaign_response.status_code == 409

    campaign_list_response = auth_client.get("/api/v1/campaign-targets")
    assert campaign_list_response.status_code == 200
    assert campaign_list_response.json()["total"] == 1

    completed_campaign_response = auth_client.patch(
        f"/api/v1/campaign-targets/{campaign['id']}",
        json={
            "status": CampaignStatus.COMPLETED.value,
            "result": "혜택 안내 완료",
        },
    )
    assert completed_campaign_response.status_code == 200
    completed_campaign = completed_campaign_response.json()
    assert completed_campaign["status"] == CampaignStatus.COMPLETED.value
    assert completed_campaign["processed_at"] is not None
    assert completed_campaign["result"] == "혜택 안내 완료"

    with session_factory() as session:
        current_user = session.scalar(
            select(User).where(User.username == "insight_viewer"),
        )
        assert current_user is not None
        current_user.role = UserRole.ADMIN.value
        session.commit()
    team_response = auth_client.get("/api/v1/auth/users")
    assert team_response.status_code == 200
    team_members = team_response.json()
    current_member = next(
        member for member in team_members if member["username"] == "insight_viewer"
    )
    assert current_member["role"] == UserRole.ADMIN.value
    assert current_member["is_active"] is True
    analysis_member = next(
        member for member in team_members if member["username"] == "analysis_team"
    )
    role_update_response = auth_client.patch(
        f"/api/v1/auth/users/{analysis_member['id']}",
        json={"role": UserRole.ANALYST.value},
    )
    assert role_update_response.status_code == 200
    assert role_update_response.json()["role"] == UserRole.ANALYST.value
    deactivate_response = auth_client.patch(
        f"/api/v1/auth/users/{analysis_member['id']}",
        json={"is_active": False},
    )
    assert deactivate_response.status_code == 200
    assert deactivate_response.json()["is_active"] is False
    inactive_view_response = auth_client.get(
        "/api/v1/auth/users",
        params={"include_inactive": True},
    )
    assert inactive_view_response.status_code == 200
    assert any(
        member["id"] == analysis_member["id"] and not member["is_active"]
        for member in inactive_view_response.json()
    )
    reactivate_response = auth_client.patch(
        f"/api/v1/auth/users/{analysis_member['id']}",
        json={"is_active": True},
    )
    assert reactivate_response.status_code == 200
    self_deactivate_response = auth_client.patch(
        f"/api/v1/auth/users/{current_member['id']}",
        json={"is_active": False},
    )
    assert self_deactivate_response.status_code == 400
    with session_factory() as session:
        current_user = session.scalar(
            select(User).where(User.username == "insight_viewer"),
        )
        assert current_user is not None
        current_user.role = UserRole.ANALYST.value
        session.commit()
    team_response_for_analyst = auth_client.get("/api/v1/auth/users")
    assert team_response_for_analyst.status_code == 200
    forbidden_inactive_view_response = auth_client.get(
        "/api/v1/auth/users",
        params={"include_inactive": True},
    )
    assert forbidden_inactive_view_response.status_code == 403
    forbidden_role_update_response = auth_client.patch(
        f"/api/v1/auth/users/{analysis_member['id']}",
        json={"role": UserRole.OPERATIONS.value},
    )
    assert forbidden_role_update_response.status_code == 403
    forbidden_campaign_response = auth_client.patch(
        f"/api/v1/campaign-targets/{campaign['id']}",
        json={"status": CampaignStatus.CANCELLED.value},
    )
    assert forbidden_campaign_response.status_code == 403


def test_openapi_and_swagger_are_available(client: TestClient) -> None:
    """OpenAPI·Swagger가 제공되고 공개 경로가 의도와 일치하는지 확인합니다."""
    openapi_response = client.get("/openapi.json")

    assert openapi_response.status_code == 200
    assert client.get("/docs").status_code == 200
    paths = openapi_response.json()["paths"]
    assert "/api/v1/predictions" in paths
    assert "/api/v1/customer-insights" in paths
    assert "/api/v1/customer-insights/{customer_id}" in paths
    assert "/api/v1/customer-insights/history/{customer_id}" in paths
    assert "/api/v1/model-runs/latest" in paths
    assert "/api/v1/campaign-targets" in paths
    assert "/api/v1/models" not in paths
    assert "/health" not in paths


def test_incomplete_manifest_is_rejected(
    model_dir: Path,
    tmp_path: Path,
) -> None:
    """필수 메타데이터가 빠진 manifest를 적재하지 않는지 확인합니다."""
    invalid_dir = tmp_path / "incomplete"
    shutil.copytree(model_dir, invalid_dir)
    manifest = json.loads(
        (invalid_dir / "classification_manifest.json").read_text(
            encoding="utf-8"
        )
    )
    manifest.pop("generated_at")
    write_manifest(invalid_dir, manifest)

    with pytest.raises(ModelLoadError, match="Invalid model manifest"):
        ModelRegistry(invalid_dir).load()


def test_artifact_path_traversal_is_rejected(
    model_dir: Path,
    tmp_path: Path,
) -> None:
    """MODEL_DIR 밖의 모델 파일을 가리키는 경로 조작을 차단합니다."""
    invalid_dir = tmp_path / "traversal" / "models"
    invalid_dir.mkdir(parents=True)
    outside_artifact = invalid_dir.parent / "classification_xgboost.joblib"
    shutil.copy2(
        model_dir / "classification_xgboost.joblib",
        outside_artifact,
    )
    manifest = make_manifest(outside_artifact)
    manifest["default_model"]["artifact"] = (
        "../classification_xgboost.joblib"
    )
    write_manifest(invalid_dir, manifest)

    with pytest.raises(ModelLoadError, match="inside MODEL_DIR"):
        ModelRegistry(invalid_dir).load()


def test_hash_mismatch_is_rejected(
    model_dir: Path,
    tmp_path: Path,
) -> None:
    """manifest와 모델 파일의 해시가 다르면 적재를 거부합니다."""
    invalid_dir = tmp_path / "hash-mismatch"
    shutil.copytree(model_dir, invalid_dir)
    manifest = json.loads(
        (invalid_dir / "classification_manifest.json").read_text(
            encoding="utf-8"
        )
    )
    manifest["default_model"]["sha256"] = "f" * 64
    write_manifest(invalid_dir, manifest)

    with pytest.raises(ModelLoadError, match="hash mismatch"):
        ModelRegistry(invalid_dir).load()
