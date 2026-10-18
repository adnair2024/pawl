const router = require("express").Router();
const { requireAdmin } = require("../auth");
router.get("/users", requireAdmin, (req, res) => res.json([]));
router.get("/stats", (req, res) => res.json({}));
module.exports = router;
