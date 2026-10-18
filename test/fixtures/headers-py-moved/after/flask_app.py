from flask import Flask
from flask_cors import CORS

from security import add_headers

app = Flask(__name__)
CORS(app, resources={r"/api/*": {"origins": ["https://a.example.com"]}})
app.after_request(add_headers)
