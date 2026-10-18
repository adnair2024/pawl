const express = require("express");
const { requireAuth } = require("./auth");
const app = express();
app.get("/a", requireAuth, (req, res) => res.send("a"));
app.get("/b", requireAuth, (req, res) => res.send("b"));
app.listen(3000);
