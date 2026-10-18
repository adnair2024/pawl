from fastapi import Depends, FastAPI

from app.deps import get_current_user
from app.routers import users

app = FastAPI()
app.include_router(users.router, prefix="/users", dependencies=[Depends(get_current_user)])
