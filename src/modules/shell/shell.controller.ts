import { Request, Response } from "express";
import { isChatFirstEnabled } from "./shell.flags";

export const getChatFirstFlagController = async (_req: Request, res: Response) => {
  res.status(200).json({ data: { enabled: isChatFirstEnabled() } });
};
