import { Request, Response, NextFunction } from "express";
import { body, validationResult } from "express-validator";

// Email validation
export const validateEmail = body("email")
  .isEmail()
  .normalizeEmail()
  .withMessage("Please provide a valid email address");

// Password validation
export const validatePassword = body("password")
  .isLength({ min: 8 })
  .withMessage("Password must be at least 8 characters long")
  .matches(/^(?=.*[a-z])(?=.*[A-Z])(?=.*\d)(?=.*[@$!%*?&])[A-Za-z\d@$!%*?&]/)
  .withMessage(
    "Password must contain at least one uppercase letter, one lowercase letter, one number, and one special character",
  );

// Role validation
export const validateRole = body("role")
  .optional()
  .isIn(["user", "admin", "manager"])
  .withMessage("Role must be either 'user' or 'admin'");

// User registration validation
export const validateUserRegistration = [
  validateEmail,
  validatePassword,
  validateRole,
  handleValidationErrors,
];

// User login validation
export const validateUserLogin = [
  validateEmail,
  body("password").notEmpty().withMessage("Password is required"),
  handleValidationErrors,
];

// Admin registration validation
export const validateAdminRegistration = [
  validateEmail,
  validatePassword,
  handleValidationErrors,
];

// Content generation validation
export const validateContentGeneration = [
  body("topic")
    .notEmpty()
    .trim()
    .isLength({ min: 3, max: 200 })
    .withMessage("Topic must be between 3 and 200 characters"),
  body("tone")
    .optional()
    .isIn(["casual", "professional", "funny", "exciting", "informative"])
    .withMessage(
      "Tone must be one of: casual, professional, funny, exciting, informative",
    ),
  body("length")
    .optional()
    .isIn(["short", "medium", "long"])
    .withMessage("Length must be one of: short, medium, long"),
  body("keywords")
    .optional()
    .isArray()
    .withMessage("Keywords must be an array"),
  body("context")
    .optional()
    .trim()
    .isLength({ max: 500 })
    .withMessage("Context must be less than 500 characters"),
  body("generateImage")
    .optional()
    .isBoolean()
    .withMessage("generateImage must be a boolean"),
  handleValidationErrors,
];

// Lead validation
export const validateLead = [
  body("name")
    .notEmpty()
    .trim()
    .isLength({ min: 2, max: 100 })
    .withMessage("Name must be between 2 and 100 characters"),
  body("email")
    .isEmail()
    .normalizeEmail()
    .withMessage("Please provide a valid email address"),
  body("url").optional().isURL().withMessage("URL must be a valid URL"),
  body("message")
    .optional()
    .trim()
    .isLength({ max: 1000 })
    .withMessage("Message must be less than 1000 characters"),
  handleValidationErrors,
];

// Facebook post validation
export const validateFacebookPost = [
  body("pageId").notEmpty().trim().withMessage("Page ID is required"),
  body("message")
    .notEmpty()
    .trim()
    .isLength({ min: 1, max: 2000 })
    .withMessage("Message must be between 1 and 2000 characters"),
  body("accessToken").notEmpty().trim().withMessage("Access token is required"),
  body("imageUrl")
    .optional()
    .isURL()
    .withMessage("Image URL must be a valid URL"),
  handleValidationErrors,
];

// Facebook schedule validation
export const validateFacebookSchedule = [
  body("pageId").notEmpty().trim().withMessage("Page ID is required"),
  body("message")
    .notEmpty()
    .trim()
    .isLength({ min: 1, max: 2000 })
    .withMessage("Message must be between 1 and 2000 characters"),
  body("accessToken").notEmpty().trim().withMessage("Access token is required"),
  body("scheduleTime")
    .isNumeric()
    .isInt({ min: Math.floor(Date.now() / 1000) + 60 }) // At least 1 minute in the future
    .withMessage(
      "Schedule time must be a valid Unix timestamp at least 1 minute in the future",
    ),
  handleValidationErrors,
];

// Error handling middleware
export function handleValidationErrors(
  req: Request,
  res: Response,
  next: NextFunction,
) {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(400).json({
      error: "Validation failed",
      details: errors.array().map((err) => ({
        field: err.type === "field" ? err.path : "unknown",
        message: err.msg,
        value: err.type === "field" ? err.value : undefined,
      })),
    });
  }
  next();
}
