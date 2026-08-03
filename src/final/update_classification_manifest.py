"""최종 분류 모델을 Docker 배치의 기본 모델로 등록합니다."""

from __future__ import annotations

import hashlib
import json
from datetime import datetime
from pathlib import Path
import sys

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import lightgbm
import pandas as pd

from common.config import MODEL_DIR, REPORT_DIR


def _sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def update_manifest() -> None:
    """classification_final.py가 만든 모델을 manifest의 기본 모델로 지정합니다."""
    manifest_path = MODEL_DIR / "classification_manifest.json"
    model_path = MODEL_DIR / "classification_lightgbm_final.joblib"
    metrics_path = REPORT_DIR / "classification_final_metrics.csv"

    for path in (manifest_path, model_path, metrics_path):
        if not path.is_file():
            raise FileNotFoundError(f"Required classification artifact not found: {path}")

    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    metrics = pd.read_csv(metrics_path).iloc[0]

    manifest["default_model"] = {
        "name": "lightgbm_final",
        "artifact": model_path.name,
        "sha256": _sha256(model_path),
        "size_bytes": model_path.stat().st_size,
        "decision_threshold": 0.5,
    }
    manifest.setdefault("test_metrics", {})["lightgbm_final"] = {
        "accuracy": float(metrics["Accuracy"]),
        "precision": float(metrics["Precision"]),
        "recall": float(metrics["Recall"]),
        "f1": float(metrics["F1"]),
        "roc_auc": float(metrics["ROC_AUC"]),
    }
    manifest.setdefault("runtime", {})["lightgbm"] = lightgbm.__version__
    manifest["generated_at"] = datetime.now().astimezone().isoformat(timespec="seconds")

    temporary_path = manifest_path.with_name(f".{manifest_path.name}.tmp")
    temporary_path.write_text(
        json.dumps(manifest, ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
    )
    temporary_path.replace(manifest_path)
    print(f"Classification manifest updated: {manifest_path}")


if __name__ == "__main__":
    update_manifest()
