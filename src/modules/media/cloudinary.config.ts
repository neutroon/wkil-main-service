import { v2 as cloudinary } from "cloudinary";
import { logger } from "@utils/logger";
import { env } from "@config/env";

// Debug: Log environment variables
logger.info("Cloudinary Config:");
logger.info("CLOUDINARY_CLOUD_NAME: " + (env.CLOUDINARY_CLOUD_NAME ? "Set" : "Not set"));
logger.info("CLOUDINARY_API_KEY: " + (env.CLOUDINARY_API_KEY ? "Set" : "Not set"));
logger.info("CLOUDINARY_API_SECRET: " + (env.CLOUDINARY_API_SECRET ? "Set" : "Not set"));

cloudinary.config({
  cloud_name: env.CLOUDINARY_CLOUD_NAME,
  api_key: env.CLOUDINARY_API_KEY,
  api_secret: env.CLOUDINARY_API_SECRET,
});

export default cloudinary;


