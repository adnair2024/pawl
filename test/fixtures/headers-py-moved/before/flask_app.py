from flask import Flask
from flask_cors import CORS
from flask_talisman import Talisman

app = Flask(__name__)
CORS(app, origins=["https://a.example.com"])
Talisman(app)
