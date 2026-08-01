"""BankChurners 원본 고객 10,127명을 MySQL customers 테이블에 적재합니다."""

from __future__ import annotations

import argparse
from pathlib import Path

from backend.app.config import PROJECT_ROOT, get_database_url
from backend.app.customer_import import load_customer_rows, upsert_customers
from backend.app.database import initialize_database


DEFAULT_DATA_PATH = PROJECT_ROOT / "data" / "raw" / "BankChurners.csv"


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--data-path",
        type=Path,
        default=DEFAULT_DATA_PATH,
        help="BankChurners 원본 CSV 경로",
    )
    return parser.parse_args()


def main() -> None:
    args = parse_args()
    database_url = get_database_url()
    if not database_url:
        raise RuntimeError("DATABASE_URL must be configured before importing customers.")

    rows = load_customer_rows(args.data_path.resolve())
    engine, session_factory = initialize_database(database_url)
    try:
        with session_factory.begin() as session:
            summary = upsert_customers(session, rows)
    finally:
        engine.dispose()

    print(
        "Customer import complete: "
        f"processed={summary.processed}, "
        f"inserted={summary.inserted}, "
        f"updated={summary.updated}, "
        f"total={summary.total_customers}"
    )


if __name__ == "__main__":
    main()

