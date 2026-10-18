const express = require("express");
const session = require("express-session");
const { requireAuth, requireRole } = require("./auth");
const adminRouter = require("./routes/admin");
const postsRouter = require("./routes/posts");
const publicRouter = require("./routes/public");
const itemsRouter = require("./routes/items");

const app = express();
app.use(express.json());
app.use(session({ secret: "x" }));
app.get("env");
app.use("/public", publicRouter);
app.use("/api", itemsRouter);
app.use("/admin", requireAuth, requireRole("admin"), adminRouter);
app.use(requireAuth);
app.use("/posts", postsRouter);
app.get("/me", (req, res) => res.json(req.user));
app.listen(3000);
