"""로컬 학습 산출물 없이 API와 모델 레지스트리를 검증하는 테스트입니다."""

from __future__ import annotations

import hashlib
import json
import shutil
from collections.abc import Iterator
from pathlib import Path
from typing import Any

import joblib
import pytest
from fastapi.testclient import TestClient

from backend.app.main import create_app
from backend.app.migration_runner import upgrade_database
from backend.app.model_registry import ModelLoadError, ModelRegistry
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
    assert signup_response.json()["user"]["role"] == "operations"
    assert "password" not in signup_response.json()["user"]

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


def test_openapi_and_swagger_are_available(client: TestClient) -> None:
    """OpenAPI·Swagger가 제공되고 공개 경로가 의도와 일치하는지 확인합니다."""
    openapi_response = client.get("/openapi.json")

    assert openapi_response.status_code == 200
    assert client.get("/docs").status_code == 200
    paths = openapi_response.json()["paths"]
    assert "/api/v1/predictions" in paths
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
