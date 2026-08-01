"""회원가입, 로그인, 로그아웃과 인증 쿠키를 제공합니다."""

from __future__ import annotations

from datetime import datetime, timedelta, timezone

import jwt
from argon2 import PasswordHasher
from argon2.exceptions import InvalidHashError, VerificationError
from fastapi import APIRouter, Depends, HTTPException, Request, Response, status
from jwt import InvalidTokenError
from sqlalchemy import select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from .config import (
    AUTH_COOKIE_NAME,
    get_auth_cookie_secure,
    get_jwt_secret,
)
from .database import get_db
from .models import User
from .schemas import (
    AuthResponse,
    LoginRequest,
    SignupRequest,
    UserResponse,
)


auth_router = APIRouter(
    prefix="/api/v1/auth",
    tags=["auth"],
)
password_hasher = PasswordHasher()
ACCESS_TOKEN_ALGORITHM = "HS256"
DEFAULT_SESSION_SECONDS = 60 * 60 * 8
REMEMBERED_SESSION_SECONDS = 60 * 60 * 24 * 30


def hash_password(password: str) -> str:
    """비밀번호를 Argon2id 해시로 변환합니다."""
    return password_hasher.hash(password)


def verify_password(password: str, password_hash: str) -> bool:
    """입력 비밀번호가 저장된 Argon2 해시와 일치하는지 확인합니다."""
    try:
        return password_hasher.verify(password_hash, password)
    except (InvalidHashError, VerificationError):
        return False


def _require_jwt_secret(request: Request) -> str:
    """애플리케이션 상태 또는 환경변수에서 JWT 서명 키를 가져옵니다."""
    secret = getattr(request.app.state, "jwt_secret", None) or get_jwt_secret()
    if not secret:
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="Authentication is not configured.",
        )
    return secret


def _create_access_token(
    user_id: int,
    secret: str,
    lifetime_seconds: int,
) -> str:
    """사용자 식별자와 만료 시각을 포함한 JWT를 생성합니다."""
    now = datetime.now(timezone.utc)
    payload = {
        "sub": str(user_id),
        "iat": now,
        "exp": now + timedelta(seconds=lifetime_seconds),
    }
    return jwt.encode(payload, secret, algorithm=ACCESS_TOKEN_ALGORITHM)


def _set_auth_cookie(response: Response, token: str, max_age: int) -> None:
    """브라우저 JavaScript에서 읽을 수 없는 인증 쿠키를 설정합니다."""
    response.set_cookie(
        key=AUTH_COOKIE_NAME,
        value=token,
        max_age=max_age,
        httponly=True,
        secure=get_auth_cookie_secure(),
        samesite="lax",
        path="/",
    )


def _authentication_error() -> HTTPException:
    """인증 실패 시 계정 존재 여부가 노출되지 않는 공통 오류를 반환합니다."""
    return HTTPException(
        status_code=status.HTTP_401_UNAUTHORIZED,
        detail="Invalid username or password.",
    )


def get_current_user(
    request: Request,
    db: Session = Depends(get_db),
) -> User:
    """HttpOnly 인증 쿠키를 검증하고 현재 사용자를 반환합니다."""
    token = request.cookies.get(AUTH_COOKIE_NAME)
    if not token:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Authentication is required.",
        )

    secret = _require_jwt_secret(request)
    try:
        payload = jwt.decode(
            token,
            secret,
            algorithms=[ACCESS_TOKEN_ALGORITHM],
        )
        subject = payload.get("sub")
        user_id = int(subject) if subject is not None else 0
    except (InvalidTokenError, TypeError, ValueError):
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Invalid or expired authentication.",
        ) from None

    user = db.get(User, user_id)
    if user is None or not user.is_active:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="The authenticated user is no longer available.",
        )
    return user


@auth_router.post(
    "/signup",
    response_model=AuthResponse,
    status_code=status.HTTP_201_CREATED,
    summary="팀 계정 회원가입",
)
def signup(payload: SignupRequest, db: Session = Depends(get_db)) -> AuthResponse:
    """새 팀 계정을 만들고 사용자 정보를 반환합니다."""
    existing_user = db.scalar(
        select(User).where(User.username == payload.username),
    )
    if existing_user is not None:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail="The username is already registered.",
        )

    user = User(
        username=payload.username,
        display_name=payload.display_name,
        password_hash=hash_password(payload.password),
    )
    db.add(user)
    try:
        db.commit()
    except IntegrityError:
        db.rollback()
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail="The username is already registered.",
        ) from None

    db.refresh(user)
    return AuthResponse(user=UserResponse.model_validate(user))


@auth_router.post(
    "/login",
    response_model=AuthResponse,
    summary="팀 계정 로그인",
)
def login(
    payload: LoginRequest,
    response: Response,
    request: Request,
    db: Session = Depends(get_db),
) -> AuthResponse:
    """자격 증명을 검증하고 HttpOnly 세션 쿠키를 발급합니다."""
    user = db.scalar(
        select(User).where(User.username == payload.username),
    )
    if user is None or not user.is_active:
        raise _authentication_error()
    if not verify_password(payload.password, user.password_hash):
        raise _authentication_error()

    lifetime = (
        REMEMBERED_SESSION_SECONDS
        if payload.remember_me
        else DEFAULT_SESSION_SECONDS
    )
    token = _create_access_token(
        user_id=user.id,
        secret=_require_jwt_secret(request),
        lifetime_seconds=lifetime,
    )
    _set_auth_cookie(response, token, lifetime)
    return AuthResponse(user=UserResponse.model_validate(user))


@auth_router.get(
    "/me",
    response_model=UserResponse,
    summary="현재 로그인 사용자 조회",
)
def me(current_user: User = Depends(get_current_user)) -> UserResponse:
    """현재 인증 쿠키에 연결된 사용자 정보를 반환합니다."""
    return UserResponse.model_validate(current_user)


@auth_router.post(
    "/logout",
    status_code=status.HTTP_204_NO_CONTENT,
    summary="로그아웃",
)
def logout(response: Response) -> None:
    """브라우저의 인증 쿠키를 삭제합니다."""
    response.delete_cookie(
        key=AUTH_COOKIE_NAME,
        path="/",
    )
