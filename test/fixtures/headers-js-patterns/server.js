const express = require("express");
const cors = require("cors");
const helmet = require("helmet");

const app = express();
app.use(helmet({ contentSecurityPolicy: false, hsts: false }));
app.use(cors({ origin: ["https://app.example.com"] }));
