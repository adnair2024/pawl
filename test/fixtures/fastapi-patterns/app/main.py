from fastapi import FastAPI, Depends

from app.deps import get_current_user
from app import legacy
from app.routers import items, public, users

app = FastAPI()
app.include_router(public.router)
app.include_router(users.router, prefix="/users", dependencies=[Depends(get_current_user)])
app.include_router(items.router, prefix="/items")
app.include_router(legacy.router)


@app.get("/health")
def health():
    return {"ok": True}


def export_endpoint():
    return "csv"


app.add_api_route("/export", export_endpoint, methods=["POST"], dependencies=[Depends(get_current_user)])
