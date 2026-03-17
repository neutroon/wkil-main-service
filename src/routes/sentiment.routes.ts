import { Router, Request, Response } from "express";
// import fetch from "node-fetch";

// Environment variable for ML service
const ML_SERVICE_URL =
  process.env.ML_SERVICE_URL || "https://ml.pagespilot.com/sentiment/analyze";

// Optional API key (if you secure the ML service in the future)
const ML_API_KEY = process.env.ML_API_KEY || "";

const router = Router();

router.post("/", async (req: Request, res: Response) => {
  try {
    const { text } = req.body;

    if (!text || text.trim().length < 1) {
      return res.status(400).json({ error: "Text is required" });
    }

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
      return res.status(500).json({
        error: "ML service failed",
        details: mlData,
      });
    }

    // Send back result
    return res.json({ sentiment: mlData });
  } catch (error) {
    console.error("Sentiment integration error:", error);
    return res.status(500).json({ error: "Internal server error" });
  }
});

module.exports = router;
