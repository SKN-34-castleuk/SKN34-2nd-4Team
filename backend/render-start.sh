#!/bin/sh
set -eu

python -m backend.app.migration_runner
exec uvicorn backend.app.main:app --host 0.0.0.0 --port "${PORT:-8000}"
