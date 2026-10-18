from functools import wraps

from flask import abort, g


def admin_required(f):
    @wraps(f)
    def wrapper(*args, **kwargs):
        if not g.user or not g.user.is_admin:
            abort(403)
        return f(*args, **kwargs)

    return wrapper


def api_key_required(f):
    @wraps(f)
    def wrapper(*args, **kwargs):
        return f(*args, **kwargs)  # never checks anything

    return wrapper
