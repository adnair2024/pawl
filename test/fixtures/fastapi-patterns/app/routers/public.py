from fastapi import APIRouter

router = APIRouter()


@router.get("/ping")
def ping():
    return "pong"


from fastapi import Depends

from app.deps import get_optional_user


@router.get("/feed")
def feed(user=Depends(get_optional_user)):
    return []
