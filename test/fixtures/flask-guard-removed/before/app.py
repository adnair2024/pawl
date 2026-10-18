from flask import Flask

from views.users import users_bp

app = Flask(__name__)
app.register_blueprint(users_bp, url_prefix="/users")
