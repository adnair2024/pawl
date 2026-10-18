const express = require("express");
const { requireAuth } = require("./auth");
const server = express();
const protectedRoutes = express.Router();
protectedRoutes.use(requireAuth);
protectedRoutes.get("/a", (req, res) => res.send("a"));
protectedRoutes.get("/b", (req, res) => res.send("b"));
server.use(protectedRoutes);
server.listen(3000);
