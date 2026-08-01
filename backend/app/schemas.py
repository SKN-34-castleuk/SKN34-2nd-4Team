"""API가 주고받는 요청 및 응답 데이터 구조를 정의합니다."""

from __future__ import annotations

from datetime import datetime
from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, Field, field_validator


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
    created_at: datetime


class AuthResponse(BaseModel):
    """회원가입·로그인 성공 응답입니다."""

    user: UserResponse
