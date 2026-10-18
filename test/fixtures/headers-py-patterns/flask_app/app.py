from flask import Flask
from flask_cors import CORS
from flask_talisman import Talisman

app = Flask(__name__)
CORS(app)
Talisman(app, content_security_policy=None, strict_transport_security=False)
