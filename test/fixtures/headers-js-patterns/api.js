const express = require("express");
const cors = require("cors");

const router = express.Router();
router.use(cors());
router.use((req, res, next) => {
  res.setHeader("Permissions-Policy", "camera=()");
  next();
});
module.exports = router;
