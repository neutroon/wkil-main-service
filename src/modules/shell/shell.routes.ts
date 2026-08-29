import { Router } from "express";
import { getChatFirstFlagController } from "./shell.controller";

const shellRoutes = Router();
shellRoutes.get("/chat-first", getChatFirstFlagController);
export default shellRoutes;
