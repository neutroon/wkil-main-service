import { VertexAI } from "@google-cloud/vertexai";
import { AppError } from "../middlewares/errorHandler.middleware";
import { env } from "./env";
const projectId = env.GOOGLE_CLOUD_PROJECT_ID;
const location = env.GOOGLE_CLOUD_LOCATION || "us-central1";

const vertexAI = new VertexAI({ project: projectId, location });

// Export both text and image models
const textModel = vertexAI.getGenerativeModel({ model: "gemini-3.1-flash" });
const imageModel = vertexAI.getGenerativeModel({
  model: "imagen-3.0-generate-001",
});

export { vertexAI, textModel, imageModel, projectId, location };
