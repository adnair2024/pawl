const express = require("express");
const { requireAuth } = require("./auth");
const adminRouter = require("./routes/admin");
const app = express();
app.use("/admin", requireAuth, adminRouter);
app.listen(3000);
