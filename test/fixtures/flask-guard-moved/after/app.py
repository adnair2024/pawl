from flask import Flask
from flask_login import login_required
from flask_caching import Cache

server = Flask(__name__)
cache = Cache(server)


@server.get("/a")
@login_required
@cache.cached(timeout=30)
def renamed_view():
    return "a"
