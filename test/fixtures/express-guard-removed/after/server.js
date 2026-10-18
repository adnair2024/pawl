const express = require("express");
const adminRouter = require("./routes/admin");
const app = express();
app.use("/admin", adminRouter);
app.listen(3000);
