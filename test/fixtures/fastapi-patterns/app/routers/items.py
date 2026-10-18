from typing import Annotated

from fastapi import APIRouter, Depends, Header, HTTPException

from app.deps import get_current_active_user, get_current_user

router = APIRouter(dependencies=[Depends(get_current_user)])


@router.get("/")
def list_items():
    return []


@router.get("/mine")
def mine(user: Annotated[dict, Depends(get_current_active_user)]):
    return user


@router.post("/")
def create(payload: dict, token: str = Header(None)):
    if token is None:
        raise HTTPException(status_code=401)
    return payload
