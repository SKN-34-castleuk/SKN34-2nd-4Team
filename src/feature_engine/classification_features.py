""" 
분류 모델의 타깃과 피처 인코딩 방식을 정의
학습은 포함하지 않는다 
"""

from dataclasses import dataclass

import pandas as pd

@dataclass(frozen=True)
class ClassificationTaskSpec:
    """분류 task 하나의 타깃 정보를 담는다"""

    name : str
    target : str 

CHURN_TASK = ClassificationTaskSpec(name = "churn", target = "Target")


def encode_features(X: pd.DataFrame) -> pd.DataFrame:
    """범주형 컬럼을 원-핫 인코딩한다 (drop_first=True)"""
    cat_cols = X.select_dtypes(include=["object", "str"]).columns.tolist()
    return pd.get_dummies(X,  columns=cat_cols, drop_first=True)

