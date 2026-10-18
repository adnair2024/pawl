from fastapi import Header


def get_current_user(x_user: str = Header(None)):
    # same name as app.deps.get_current_user, but this one never refuses anyone
    return x_user
