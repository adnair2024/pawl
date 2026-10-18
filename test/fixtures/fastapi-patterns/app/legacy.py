from fastapi import APIRouter, Depends

from app.other_deps import get_current_user

router = APIRouter()


@router.get("/legacy")
def legacy(user=Depends(get_current_user)):
    return user
