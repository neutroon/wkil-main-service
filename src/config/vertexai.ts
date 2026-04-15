import { VertexAI } from "@google-cloud/vertexai";

// Validate environment variables
if (
  !process.env.GOOGLE_CLOUD_PROJECT_ID ||
  !process.env.GOOGLE_APPLICATION_CREDENTIALS
) {
  throw new Error("Missing Google Cloud configuration in .env file");
}

// Validate required environment variables
const requiredEnvVars = [
  "GOOGLE_CLOUD_PROJECT_ID",
  "GOOGLE_APPLICATION_CREDENTIALS",
  "CLOUDINARY_CLOUD_NAME",
  "CLOUDINARY_API_KEY",
  "CLOUDINARY_API_SECRET",
];

const missing = requiredEnvVars.filter((v) => !process.env[v]);
if (missing.length > 0) {
  throw new Error(
    `Missing required environment variables: ${missing.join(", ")}`
  );
}

// Debug: Log environment variables
console.log("Vertex AI Config:");
console.log(
  "GOOGLE_CLOUD_PROJECT_ID:",
  process.env.GOOGLE_CLOUD_PROJECT_ID ? "Set" : "Not set"
);
console.log(
  "GOOGLE_CLOUD_LOCATION:",
  process.env.GOOGLE_CLOUD_LOCATION ? "Set" : "Not set"
);
console.log(
  "GOOGLE_APPLICATION_CREDENTIALS:",
  process.env.GOOGLE_APPLICATION_CREDENTIALS ? "Set" : "Not set"
);

const projectId = process.env.GOOGLE_CLOUD_PROJECT_ID;
const location = process.env.GOOGLE_CLOUD_LOCATION || "us-central1";

const vertexAI = new VertexAI({ project: projectId, location });

// Export both text and image models
const textModel = vertexAI.getGenerativeModel({ model: "gemini-3.1-flash" });
const imageModel = vertexAI.getGenerativeModel({
  model: "imagen-3.0-generate-001",
});

export { vertexAI, textModel, imageModel, projectId, location };
