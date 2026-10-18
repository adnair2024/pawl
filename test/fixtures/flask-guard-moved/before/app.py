from flask import Flask
from flask_login import login_required

app = Flask(__name__)


@app.route("/a", methods=["GET"])
@login_required
def a():
    return "a"
