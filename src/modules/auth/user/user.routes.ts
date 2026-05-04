import { Router } from "express";


const userRoutes = Router();

// Public routes with rate limiting and validation

// Protected routes
// userRoutes.get("/me", authenticateToken, getCurrentUser);

export default userRoutes;

