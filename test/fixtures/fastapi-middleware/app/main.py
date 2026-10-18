from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse

app = FastAPI()


@app.middleware("http")
async def require_login(request: Request, call_next):
    if not request.headers.get("authorization"):
        return JSONResponse(status_code=401, content={"detail": "login required"})
    return await call_next(request)


@app.get("/a")
def a():
    return "a"


@app.post("/b")
def b():
    return "b"
