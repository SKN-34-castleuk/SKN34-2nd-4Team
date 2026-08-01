"""CardOps API 라우터를 한 곳에서 조합합니다."""

from fastapi import APIRouter

from .routes import auth, insights, predictions, system


api_router = APIRouter()
api_router.include_router(system.router)
api_router.include_router(predictions.router)
api_router.include_router(auth.auth_router)
api_router.include_router(insights.insights_router)
