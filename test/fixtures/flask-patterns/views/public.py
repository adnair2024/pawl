from flask import Blueprint

from auth import api_key_required

public_bp = Blueprint("public", __name__)


@public_bp.route("/ping")
def ping():
    return "pong"


@public_bp.route("/internal")
@api_key_required
def internal():
    return "internal"
