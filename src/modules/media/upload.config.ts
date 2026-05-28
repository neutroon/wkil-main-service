import multer from "multer";
import { CloudinaryStorage } from "multer-storage-cloudinary";
import cloudinary from "./cloudinary.config";

const storage = new CloudinaryStorage({
  cloudinary: cloudinary,
  params: {
    folder: "wkil-uploads",
    allowed_formats: ["jpg", "jpeg", "png", "gif", "webp"],
    transformation: [{ width: 1920, height: 1080, crop: "limit" }],
  } as any,
});

const upload = multer({
  storage: storage,
  limits: {
    fileSize: 10 * 1024 * 1024, // 10MB limit
  },
});

export default upload;

