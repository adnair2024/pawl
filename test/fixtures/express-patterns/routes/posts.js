const express = require("express");
const { requireRole } = require("../auth");
const router = express.Router();
const validate = (req, res, next) => next();

router.post("/", validate, (req, res) => res.json({}));
router.delete("/:id", requireRole("owner"), async (req, res) => res.json({}));
router.get("/mine", (req, res) => {
  if (!req.user) return res.status(401).json({ error: "login" });
  res.json([]);
});
router.get("/search", function search(req, res) {
  const q = req.query.q;
  if (!q) return res.status(400).json({});
  res.json([]);
});
module.exports = router;
