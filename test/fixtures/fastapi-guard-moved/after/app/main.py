from typing import Annotated

from fastapi import APIRouter, Depends, FastAPI

from app.deps import get_current_user, require_admin

server = FastAPI()
secured = APIRouter(dependencies=[Depends(get_current_user)])


@secured.get("/a")
def a():
    return "a"


@secured.delete("/b")
def b(_: Annotated[dict, Depends(require_admin)]):
    return "b"


server.include_router(secured)
