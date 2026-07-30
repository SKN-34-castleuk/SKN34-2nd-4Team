"""고객 이탈 여부를 예측하는 최종 분류 모델(LightGBM). 학습·평가·저장을 담당한다.

실행:
    python src/final/classification_final.py
"""

import sys
from pathlib import Path

SRC_DIR = Path(__file__).resolve().parents[1]
PROJECT_ROOT = SRC_DIR.parent
sys.path.insert(0, str(SRC_DIR))

import joblib
import pandas as pd
from lightgbm import LGBMClassifier
from sklearn.metrics import (
    accuracy_score,
    f1_score,
    precision_score,
    recall_score,
    roc_auc_score,
)
from sklearn.model_selection import train_test_split

from feature_engine.classification_features import CHURN_TASK, encode_features
from hyperparameter.classification_search import get_best_params


DATA_PATH = PROJECT_ROOT / "data" / "processed" / "bankchurners_clean.csv"
MODEL_DIR = PROJECT_ROOT / "outputs" / "models"
REPORT_DIR = PROJECT_ROOT / "outputs" / "reports"
RANDOM_STATE = 42


def main() -> None:
    """LightGBM을 최종 학습하고 test셋으로 1회 평가한 뒤 저장한다."""
    df = pd.read_csv(DATA_PATH)
    X = encode_features(df.drop(columns=[CHURN_TASK.target]))
    y = df[CHURN_TASK.target]

    X_train, X_temp, y_train, y_temp = train_test_split(
        X, y, test_size=0.4, random_state=RANDOM_STATE, stratify=y
    )
    X_val, X_test, y_val, y_test = train_test_split(
        X_temp, y_temp, test_size=0.5, random_state=RANDOM_STATE, stratify=y_temp
    )

    X_trainval = pd.concat([X_train, X_val])
    y_trainval = pd.concat([y_train, y_val])

    best_params = get_best_params()
    final_model = LGBMClassifier(
        **best_params, class_weight="balanced", random_state=RANDOM_STATE, verbose=-1,
    )
    final_model.fit(X_trainval, y_trainval)

    y_pred = final_model.predict(X_test)
    y_proba = final_model.predict_proba(X_test)[:, 1]

    metrics = {
        "Model": "lightgbm_final",
        "Accuracy": accuracy_score(y_test, y_pred),
        "Precision": precision_score(y_test, y_pred),
        "Recall": recall_score(y_test, y_pred),
        "F1": f1_score(y_test, y_pred),
        "ROC_AUC": roc_auc_score(y_test, y_proba),
    }

    MODEL_DIR.mkdir(parents=True, exist_ok=True)
    REPORT_DIR.mkdir(parents=True, exist_ok=True)

    joblib.dump(final_model, MODEL_DIR / "classification_lightgbm_final.joblib")
    pd.DataFrame([metrics]).to_csv(
        REPORT_DIR / "classification_final_metrics.csv", index=False
    )

    print("\n[분류 최종 모델(LightGBM) 성능]")
    print(pd.DataFrame([metrics]).round(4).to_string(index=False))
    print(f"\n모델 저장 위치: {MODEL_DIR / 'classification_lightgbm_final.joblib'}")
    print(f"결과 저장 위치: {REPORT_DIR / 'classification_final_metrics.csv'}")



if __name__ == "__main__":
    main()

