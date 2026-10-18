from flask import Flask, abort
from flask_jwt_extended import jwt_required
from flask_login import current_user, login_required

from views.public import public_bp
from views.users import users_bp

app = Flask(__name__)
app.register_blueprint(users_bp, url_prefix="/users")
app.register_blueprint(public_bp)


@app.route("/")
def index():
    return "home"


@app.route("/dashboard")
@login_required
def dashboard():
    return "dash"


@login_required  # above the route decorator: Flask registers the undecorated function, so this does nothing
@app.route("/oops")
def oops():
    return "oops"


@app.route("/api/items", methods=["GET", "POST"])
@jwt_required()
def items():
    return "items"


@app.route("/api/maybe")
@jwt_required(optional=True)
def maybe():
    return "maybe"


@app.get("/settings")
def settings():
    if not current_user.is_authenticated:
        abort(401)
    return "settings"
