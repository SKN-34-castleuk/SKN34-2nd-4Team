"""API가 주고받는 요청 및 응답 데이터 구조를 정의합니다."""

from __future__ import annotations

from datetime import datetime
from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator

from .enums import CampaignStatus, ModelRunStatus, RiskLevel, UserRole


# 프론트엔드용 snake_case 필드명을 학습 데이터의 원본 컬럼명으로 연결합니다.
PREDICTION_FIELD_MAP = {
    "customer_age": "Customer_Age",
    "gender": "Gender",
    "dependent_count": "Dependent_count",
    "education_level": "Education_Level",
    "marital_status": "Marital_Status",
    "income_category": "Income_Category",
    "card_category": "Card_Category",
    "months_on_book": "Months_on_book",
    "total_relationship_count": "Total_Relationship_Count",
    "months_inactive_12_mon": "Months_Inactive_12_mon",
    "contacts_count_12_mon": "Contacts_Count_12_mon",
    "credit_limit": "Credit_Limit",
    "total_revolving_bal": "Total_Revolving_Bal",
    "avg_open_to_buy": "Avg_Open_To_Buy",
    "total_amt_chng_q4_q1": "Total_Amt_Chng_Q4_Q1",
    "total_trans_amt": "Total_Trans_Amt",
    "total_trans_ct": "Total_Trans_Ct",
    "total_ct_chng_q4_q1": "Total_Ct_Chng_Q4_Q1",
    "avg_utilization_ratio": "Avg_Utilization_Ratio",
}


class LivenessResponse(BaseModel):
    """API 프로세스의 생존 상태 응답입니다."""

    status: Literal["ok"]
    service: str
    version: str


class HealthResponse(BaseModel):
    """API와 적재된 모델의 준비 상태 응답입니다."""

    status: Literal["ok"]
    service: str
    version: str
    model_loaded: bool
    model_name: str
    model_artifact: str
    manifest_generated_at: str


class PredictionRequest(BaseModel):
    """학습된 분류 파이프라인이 요구하는 고객 특성 입력값입니다."""

    # 정의되지 않은 필드가 실수로 모델 입력에 섞이지 않도록 거부합니다.
    model_config = ConfigDict(extra="forbid")

    customer_age: int = Field(ge=26, le=73)
    gender: Literal["F", "M"]
    dependent_count: int = Field(ge=0, le=5)
    education_level: Literal[
        "College",
        "Doctorate",
        "Graduate",
        "High School",
        "Post-Graduate",
        "Uneducated",
        "Unknown",
    ]
    marital_status: Literal["Divorced", "Married", "Single", "Unknown"]
    income_category: Literal[
        "$120K +",
        "$40K - $60K",
        "$60K - $80K",
        "$80K - $120K",
        "Less than $40K",
        "Unknown",
    ]
    card_category: Literal["Blue", "Gold", "Platinum", "Silver"]
    months_on_book: int = Field(ge=13, le=56)
    total_relationship_count: int = Field(ge=1, le=6)
    months_inactive_12_mon: int = Field(ge=0, le=6)
    contacts_count_12_mon: int = Field(ge=0, le=6)
    credit_limit: float = Field(ge=1438.3, le=34516.0)
    total_revolving_bal: int = Field(ge=0, le=2517)
    avg_open_to_buy: float = Field(ge=3.0, le=34516.0)
    total_amt_chng_q4_q1: float = Field(ge=0.0, le=3.397)
    total_trans_amt: int = Field(ge=510, le=18484)
    total_trans_ct: int = Field(ge=10, le=139)
    total_ct_chng_q4_q1: float = Field(ge=0.0, le=3.714)
    avg_utilization_ratio: float = Field(ge=0.0, le=0.999)

    def to_model_input(self) -> dict[str, Any]:
        """검증된 API 입력을 모델이 학습한 원본 컬럼명 구조로 변환합니다."""
        values = self.model_dump()
        return {
            model_field: values[request_field]
            for request_field, model_field in PREDICTION_FIELD_MAP.items()
        }


class PredictionResponse(BaseModel):
    """고객 이탈 예측 결과와 사용된 모델 정보를 반환하는 응답입니다."""

    prediction: int
    status: str
    churn_probability: float = Field(ge=0.0, le=1.0)
    decision_threshold: float = Field(ge=0.0, le=1.0)
    model_name: str
    model_version: str


class CustomerProfileResponse(BaseModel):
    """분석 상세 화면에 제공할 고객 원본 특성입니다."""

    model_config = ConfigDict(from_attributes=True)

    customer_id: int
    customer_age: int
    gender: str
    dependent_count: int
    education_level: str
    marital_status: str
    income_category: str
    card_category: str
    months_on_book: int
    total_relationship_count: int
    months_inactive_12_mon: int
    contacts_count_12_mon: int
    credit_limit: float
    total_revolving_bal: int
    avg_open_to_buy: float
    total_amt_chng_q4_q1: float
    total_trans_amt: int
    total_trans_ct: int
    total_ct_chng_q4_q1: float
    avg_utilization_ratio: float
    created_at: datetime
    updated_at: datetime


class CustomerInsightResponse(BaseModel):
    """고객별 최신 분석 결과 목록 항목입니다."""

    model_config = ConfigDict(from_attributes=True)

    id: int
    customer_id: int
    customer_snapshot_id: int | None = None
    classification_run_id: int
    regression_run_id: int
    clustering_run_id: int
    churn_probability: float = Field(ge=0.0, le=1.0)
    risk_level: RiskLevel
    expected_transaction_count: float = Field(ge=0.0)
    activity_gap: float
    cluster_name: str
    cluster_confidence: float | None = Field(default=None, ge=0.0, le=1.0)
    recommended_action: str
    reason_codes: list[str] | dict[str, Any] | None
    scored_at: datetime


class CustomerInsightStats(BaseModel):
    """필터가 적용된 분석 결과의 대시보드 요약 통계입니다."""

    total: int
    average_churn_probability: float = Field(ge=0.0, le=1.0)
    risk_counts: dict[str, int]
    cluster_counts: dict[str, int]


class CustomerInsightHistoryResponse(BaseModel):
    """고객 한 명의 분석 스냅샷 이력입니다."""

    customer_id: int
    items: list[CustomerInsightResponse]


class ModelRunResponse(BaseModel):
    """모델 배치 실행 이력의 외부 응답 구조입니다."""

    model_config = ConfigDict(from_attributes=True)

    id: int
    task: str
    model_name: str
    model_version: str
    artifact_sha256: str
    dataset_sha256: str | None
    decision_policy_sha256: str | None
    medium_threshold: float | None
    high_threshold: float | None
    activity_gap_quantile: float | None
    status: ModelRunStatus
    processed_rows: int | None
    started_at: datetime
    completed_at: datetime | None


class LatestBatchResponse(BaseModel):
    """가장 최근 성공한 전체 모델 배치의 요약입니다."""

    status: ModelRunStatus
    started_at: datetime
    completed_at: datetime | None
    processed_rows: int | None
    dataset_sha256: str | None
    runs: list[ModelRunResponse]


class CampaignTargetResponse(BaseModel):
    """캠페인 대상과 현재 업무 처리 상태입니다."""

    id: int
    customer_id: int
    customer_insight_id: int
    campaign_name: str
    assigned_to_user_id: int | None
    assigned_to_display_name: str | None = None
    status: CampaignStatus
    processed_at: datetime | None
    result: str | None
    result_notes: str | None
    created_at: datetime
    updated_at: datetime


class CampaignTargetCreateRequest(BaseModel):
    """분석 결과를 캠페인 업무 대상으로 등록하는 요청입니다."""

    customer_insight_id: int = Field(ge=1)
    campaign_name: str = Field(min_length=1, max_length=150)
    assigned_to_user_id: int | None = Field(default=None, ge=1)

    @field_validator("campaign_name", mode="before")
    @classmethod
    def normalize_campaign_name(cls, value: object) -> object:
        if isinstance(value, str):
            return value.strip()
        return value


class CampaignTargetUpdateRequest(BaseModel):
    """캠페인 대상의 담당자·상태·처리 결과를 변경하는 요청입니다."""

    status: CampaignStatus | None = None
    assigned_to_user_id: int | None = Field(default=None, ge=1)
    result: str | None = Field(default=None, max_length=100)
    result_notes: str | None = Field(default=None, max_length=2000)


class CampaignTargetListResponse(BaseModel):
    """캠페인 대상 목록과 페이지네이션 응답입니다."""

    items: list[CampaignTargetResponse]
    page: int
    page_size: int
    total: int
    total_pages: int


class CustomerInsightListResponse(BaseModel):
    """고객 분석 결과 목록과 페이지네이션·요약 통계입니다."""

    items: list[CustomerInsightResponse]
    page: int
    page_size: int
    total: int
    total_pages: int
    stats: CustomerInsightStats


class CustomerInsightDetailResponse(CustomerInsightResponse):
    """고객 특성을 포함한 분석 결과 상세 응답입니다."""

    customer: CustomerProfileResponse


USERNAME_PATTERN = r"^[a-zA-Z0-9][a-zA-Z0-9_.-]{2,49}$"


def normalize_username(value: object) -> object:
    """팀 계정 아이디의 앞뒤 공백을 제거하고 소문자로 통일합니다."""
    if isinstance(value, str):
        return value.strip().lower()
    return value


class SignupRequest(BaseModel):
    """팀 계정 회원가입 요청입니다."""

    username: str = Field(
        min_length=3,
        max_length=50,
        pattern=USERNAME_PATTERN,
    )
    display_name: str = Field(min_length=1, max_length=100)
    password: str = Field(min_length=8, max_length=128)

    @field_validator("username", mode="before")
    @classmethod
    def normalize_signup_username(cls, value: object) -> object:
        return normalize_username(value)

    @field_validator("display_name", mode="before")
    @classmethod
    def normalize_display_name(cls, value: object) -> object:
        if isinstance(value, str):
            return value.strip()
        return value


class LoginRequest(BaseModel):
    """팀 계정 로그인 요청입니다."""

    username: str = Field(
        min_length=3,
        max_length=50,
        pattern=USERNAME_PATTERN,
    )
    password: str = Field(min_length=8, max_length=128)
    remember_me: bool = False

    @field_validator("username", mode="before")
    @classmethod
    def normalize_login_username(cls, value: object) -> object:
        return normalize_username(value)


class UserResponse(BaseModel):
    """외부에 공개할 수 있는 사용자 정보입니다."""

    model_config = ConfigDict(from_attributes=True)

    id: int
    username: str
    display_name: str
    role: UserRole
    created_at: datetime


class TeamMemberResponse(BaseModel):
    """관리자와 캠페인 담당자 선택 화면에서 사용하는 팀 계정 정보입니다."""

    model_config = ConfigDict(from_attributes=True)

    id: int
    username: str
    display_name: str
    role: UserRole
    is_active: bool
    created_at: datetime


class UserAdminUpdateRequest(BaseModel):
    """관리자가 팀 계정의 역할과 활성 상태를 변경하는 요청입니다."""

    role: UserRole | None = None
    is_active: bool | None = None

    @model_validator(mode="after")
    def require_update_value(self) -> "UserAdminUpdateRequest":
        if self.role is None and self.is_active is None:
            raise ValueError("At least one user property must be provided.")
        return self


class AuthResponse(BaseModel):
    """회원가입·로그인 성공 응답입니다."""

    user: UserResponse
