"""로컬 개발용 역할별 테스트 계정을 MySQL에 생성하거나 갱신합니다."""

from __future__ import annotations

from dataclasses import dataclass

from sqlalchemy import select
from sqlalchemy.orm import Session

from backend.app.api.routes.auth import hash_password
from backend.app.config import get_allow_test_user_seeding, get_database_url
from backend.app.database import initialize_database
from backend.app.enums import UserRole
from backend.app.models import User


@dataclass(frozen=True)
class TestUser:
    """시드할 로컬 테스트 계정 정보입니다."""

    username: str
    display_name: str
    password: str
    role: UserRole


TEST_USERS = (
    TestUser(
        username="test_admin",
        display_name="테스트 관리자",
        password="CardOpsAdmin2026!",
        role=UserRole.ADMIN,
    ),
    TestUser(
        username="test_analyst",
        display_name="테스트 분석팀",
        password="CardOpsAnalyst2026!",
        role=UserRole.ANALYST,
    ),
    TestUser(
        username="test_operations",
        display_name="테스트 운영팀",
        password="CardOpsOps2026!",
        role=UserRole.OPERATIONS,
    ),
    TestUser(
        username="test_marketing",
        display_name="테스트 마케팅팀",
        password="CardOpsMarketing2026!",
        role=UserRole.MARKETING,
    ),
)


def seed_test_users(session: Session) -> list[User]:
    """테스트 계정을 역할별로 생성하고 재실행 시 최신 상태로 갱신합니다."""
    users: list[User] = []
    for test_user in TEST_USERS:
        user = session.scalar(
            select(User).where(User.username == test_user.username),
        )
        if user is None:
            user = User(username=test_user.username)
            session.add(user)

        user.display_name = test_user.display_name
        user.password_hash = hash_password(test_user.password)
        user.role = test_user.role.value
        user.is_active = True
        users.append(user)

    session.commit()
    return users


def main() -> None:
    """환경변수 DATABASE_URL의 DB에 로컬 테스트 계정을 저장합니다."""
    if not get_allow_test_user_seeding():
        raise RuntimeError(
            "Test user seeding is disabled. Set ALLOW_TEST_USER_SEEDING=true "
            "only in a local development environment."
        )
    database_url = get_database_url()
    if not database_url:
        raise RuntimeError("DATABASE_URL must be configured before seeding test users.")

    engine, session_factory = initialize_database(database_url)
    try:
        with session_factory() as session:
            users = seed_test_users(session)
    finally:
        engine.dispose()

    print("Test users seeded:")
    for user in users:
        print(f"- {user.username} ({user.role})")


if __name__ == "__main__":
    main()
