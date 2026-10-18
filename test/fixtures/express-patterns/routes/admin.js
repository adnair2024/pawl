const router = require("express").Router();
router.get("/stats", (req, res) => res.json({}));
module.exports = router;
