import express from "express";
import { requireAuth } from "../auth";

const router = express.Router();
router.route("/items").get(listItems).post(requireAuth, createItem);
function listItems(req: any, res: any) { res.json([]); }
function createItem(req: any, res: any) { res.json({}); }
export default router;
