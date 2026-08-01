"""데이터베이스와 API에서 공통으로 사용하는 제한된 상태값입니다."""

from enum import Enum


class UserRole(str, Enum):
    """CardOps 팀 사용자의 업무 역할입니다."""

    ADMIN = "admin"
    ANALYST = "analyst"
    OPERATIONS = "operations"
    MARKETING = "marketing"


class ModelRunStatus(str, Enum):
    """모델 배치 실행의 처리 상태입니다."""

    RUNNING = "running"
    SUCCEEDED = "succeeded"
    FAILED = "failed"


class RiskLevel(str, Enum):
    """고객 이탈 위험 등급입니다."""

    LOW = "low"
    MEDIUM = "medium"
    HIGH = "high"


class CampaignStatus(str, Enum):
    """캠페인 대상 고객의 업무 처리 상태입니다."""

    PENDING = "pending"
    ASSIGNED = "assigned"
    CONTACTED = "contacted"
    COMPLETED = "completed"
    CANCELLED = "cancelled"
