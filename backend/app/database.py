"""SQLAlchemy 엔진, 세션, 애플리케이션 데이터베이스 초기화를 관리합니다."""

from __future__ import annotations

from collections.abc import Generator

from fastapi import HTTPException, Request, status
from sqlalchemy import create_engine
from sqlalchemy.engine import Engine
from sqlalchemy.orm import DeclarativeBase, Session, sessionmaker


class Base(DeclarativeBase):
    """애플리케이션 테이블이 상속하는 SQLAlchemy 선언 기반입니다."""


def initialize_database(
    database_url: str,
) -> tuple[Engine, sessionmaker[Session]]:
    """데이터베이스 엔진을 만들고 애플리케이션 테이블을 준비합니다."""
    # 함수 호출 시점에 모델을 가져와 Base.metadata에 User 테이블이 등록되도록
    # 합니다. 이 방식은 database.py와 models.py 사이의 import 순환도 피합니다.
    from . import models  # noqa: F401

    engine = create_engine(
        database_url,
        pool_pre_ping=True,
    )
    Base.metadata.create_all(bind=engine)
    return engine, sessionmaker(
        bind=engine,
        class_=Session,
        expire_on_commit=False,
    )


def get_db(request: Request) -> Generator[Session, None, None]:
    """현재 애플리케이션이 준비한 DB 세션을 요청 단위로 제공합니다."""
    session_factory = getattr(request.app.state, "session_factory", None)
    if session_factory is None:
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="The database is not configured.",
        )

    session = session_factory()
    try:
        yield session
    finally:
        session.close()
