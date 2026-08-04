#!/bin/sh
set -eu

python -m pip install --upgrade pip
python -m pip install -r backend/requirements.txt

# outputs/ is intentionally ignored by Git because model artifacts are generated
# data. Render therefore creates the minimum online classification artifact during
# the build. Local Docker Compose continues to use the existing model-builder.
mkdir -p outputs/models outputs/reports

if [ "${RENDER_BUILD_MODELS:-true}" = "true" ] && {
    [ ! -f outputs/models/classification_manifest.json ] ||
    [ ! -f outputs/models/classification_lightgbm_final.joblib ];
}; then
    python src/final/classification_final.py
fi
