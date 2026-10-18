const express = require("express");
const cors = require("cors");
const app = express();
const ORIGINS = ["https://app.example.com", "https://admin.example.com"];
app.use(cors({ origin: (origin, cb) => (ORIGINS.includes(origin) ? cb(null, true) : cb(new Error("no"))) }));
