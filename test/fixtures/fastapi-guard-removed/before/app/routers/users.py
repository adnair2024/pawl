from fastapi import APIRouter, Depends

from app.deps import require_admin

router = APIRouter()


@router.get("/")
def list_users():
    return []


@router.delete("/{uid}", dependencies=[Depends(require_admin)])
def delete_user(uid: int):
    return {}
