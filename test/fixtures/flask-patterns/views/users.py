from flask import Blueprint, redirect, session, url_for

from auth import admin_required

users_bp = Blueprint("users", __name__)


@users_bp.before_request
def require_login():
    if not session.get("user_id"):
        return redirect(url_for("login"))


@users_bp.route("/")
def list_users():
    return "users"


@users_bp.route("/<int:uid>", methods=["DELETE"])
@admin_required
def delete_user(uid):
    return "deleted"
