from fastapi import APIRouter, Depends

from app.deps import get_current_active_user, get_db, require_admin

router = APIRouter()


@router.get("/")
def list_users(db=Depends(get_db)):
    return []


@router.delete("/{uid}", dependencies=[Depends(require_admin)])
def delete_user(uid: int):
    return {}


@router.get("/me")
def me(user=Depends(get_current_active_user)):
    return user
