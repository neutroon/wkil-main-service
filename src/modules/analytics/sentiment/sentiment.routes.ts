import { Router, Request, Response } from "express";
import { validate } from "@middlewares/validate.middleware";
import { sentimentSchema } from "./sentiment.validation";
import { AppError } from "@middlewares/errorHandler.middleware";
import { env } from "@config/env";

// Environment variable for ML service
const ML_SERVICE_URL =
  env.ML_SERVICE_URL || "https://ml.pagespilot.com/sentiment/analyze";

// Optional API key (if you secure the ML service in the future)
const ML_API_KEY = env.ML_API_KEY || "";

const router = Router();

router.post(
  "/", 
  validate(sentimentSchema),
  async (req: Request, res: Response) => {
    const { text } = req.body;

    // Build payload for ML service
    const payload = {
      text,
    };

    // Forward to ML service
    const mlRes = await fetch(ML_SERVICE_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(ML_API_KEY && { Authorization: `Bearer ${ML_API_KEY}` }),
      },
      body: JSON.stringify(payload),
    });

    const mlData = await mlRes.json();

    if (!mlRes.ok) {
      throw new AppError("ML service failed", 500);
    }

    // Send back result
    return res.json({ sentiment: mlData });
  }
);

export default router;




