from fastapi import Depends, HTTPException, status
from fastapi.security import OAuth2PasswordBearer

oauth2_scheme = OAuth2PasswordBearer(tokenUrl="token")


def get_db():
    yield None


async def get_current_user(token: str = Depends(oauth2_scheme)):
    credentials_exception = HTTPException(status_code=status.HTTP_401_UNAUTHORIZED)
    if not token:
        raise credentials_exception
    return {"id": 1}


def get_current_active_user(user=Depends(get_current_user)):
    return user


def require_admin(user=Depends(get_current_active_user)):
    if not user.get("admin"):
        raise HTTPException(status_code=403)
    return user


oauth2_optional = OAuth2PasswordBearer(tokenUrl="token", auto_error=False)


def get_optional_user(token: str = Depends(oauth2_optional)):
    return None
