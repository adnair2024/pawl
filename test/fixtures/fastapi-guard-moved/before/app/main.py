from fastapi import Depends, FastAPI

from app.deps import get_current_user, require_admin

app = FastAPI()


@app.get("/a", dependencies=[Depends(get_current_user)])
def a():
    return "a"


@app.delete("/b", dependencies=[Depends(require_admin)])
def b():
    return "b"
