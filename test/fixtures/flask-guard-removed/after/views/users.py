from flask import Blueprint

users_bp = Blueprint("users", __name__)


@users_bp.route("/")
def list_users():
    return "users"


@users_bp.route("/<int:uid>", methods=["DELETE"])
def delete_user(uid):
    return "deleted"
