from fastapi import APIRouter

router = APIRouter()


@router.get("/")
def list_users():
    return []


@router.delete("/{uid}")
def delete_user(uid: int):
    return {}
