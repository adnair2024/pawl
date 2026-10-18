const router = require("express").Router();
router.get("/users", (req, res) => res.json([]));
router.get("/stats", (req, res) => res.json({}));
module.exports = router;
