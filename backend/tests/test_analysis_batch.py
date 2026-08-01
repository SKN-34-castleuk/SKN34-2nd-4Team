"""분석 배치의 입력 변환과 운영 규칙을 검증합니다."""

from __future__ import annotations

import pandas as pd

from backend.app.analysis_batch import (
    _recommended_action,
    _risk_level,
    build_regression_input,
)


def make_raw_row() -> dict[str, object]:
    """회귀 입력 변환에 필요한 원본 특성 한 행을 만듭니다."""
    return {
        "Customer_Age": 45,
        "Gender": "M",
        "Dependent_count": 2,
        "Education_Level": "Graduate",
        "Marital_Status": "Married",
        "Income_Category": "$60K - $80K",
        "Card_Category": "Blue",
        "Months_on_book": 36,
        "Total_Relationship_Count": 3,
        "Months_Inactive_12_mon": 2,
        "Contacts_Count_12_mon": 2,
        "Credit_Limit": 5000.0,
        "Total_Revolving_Bal": 1000,
        "Avg_Open_To_Buy": 4000.0,
        "Total_Amt_Chng_Q4_Q1": 0.7,
        "Total_Trans_Amt": 2000,
        "Total_Trans_Ct": 50,
        "Total_Ct_Chng_Q4_Q1": 0.8,
        "Avg_Utilization_Ratio": 0.2,
    }


def test_regression_input_matches_final_feature_contract() -> None:
    """배치 회귀 입력이 타겟·누수·금액 컬럼을 제외하는지 확인합니다."""
    result = build_regression_input(pd.DataFrame([make_raw_row()]))

    assert "Total_Trans_Ct" not in result.columns
    assert "Total_Trans_Amt" not in result.columns
    assert "Total_Ct_Chng_Q4_Q1" not in result.columns
    assert {"리볼빙_한도_비율", "상품당_관계밀도", "문의_대비_보유기간", "연령대"}.issubset(
        result.columns
    )


def test_risk_and_action_policy() -> None:
    """위험도 기준과 활동성 갭 기반 액션 문구가 일관되게 적용되는지 확인합니다."""
    assert _risk_level(0.9, 0.5, 0.85) == "high"
    assert _risk_level(0.6, 0.5, 0.85) == "medium"
    assert _risk_level(0.2, 0.5, 0.85) == "low"
    assert _recommended_action("high", -3.0, "우선케어(거래 감소)") == (
        "이탈 위험 우선 상담 및 거래 활성화 혜택"
    )
