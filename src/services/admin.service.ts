import bcrypt from "bcrypt";
import prisma from "../config/prisma";
import { AppError } from "../middlewares/errorHandler.middleware";
import {
  generateAccessToken,
  generateRefreshToken,
} from "../middlewares/auth.middleware";

const createAdmin = async (name: string, email: string, password: string) => {
  const hashed = await bcrypt.hash(password, 10);

  // Check if admin already exists
  const existingAdmin = await prisma.user.findUnique({
    where: { email },
    select: { id: true, name: true, email: true, role: true },
  });

  if (existingAdmin) {
    throw new AppError("Admin already exists", 409);
  }

  return prisma.user.create({
    data: {
      name,
      email,
      password: hashed,
      role: "admin",
    },
    select: {
      id: true,
      name: true,
      email: true,
      role: true,
      createdAt: true,
    },
  });
};

// const login = async (email: string, password: string) => {
//   const admin = await prisma.user.findUnique({
//     where: { email },
//     select: { id: true, name: true, email: true, password: true, role: true },
//   });

//   if (!admin) {
//     throw new Error("Admin not found");
//   }

//   if (admin.role !== "admin") {
//     throw new Error("Access denied - admin role required");
//   }

//   const valid = await bcrypt.compare(password, admin.password);
//   if (!valid) {
//     throw new Error("Invalid credentials");
//   }

//   // Generate tokens
//   const accessToken = generateAccessToken({
//     id: admin.id,
//     name: admin.name,
//     email: admin.email,
//     role: admin.role,
//   });

//   const refreshToken = generateRefreshToken({
//     id: admin.id,
//     name: admin.name,
//     email: admin.email,
//     role: admin.role,
//   });

//   return {
//     id: admin.id,
//     name: admin.name,
//     email: admin.email,
//     role: admin.role,
//     accessToken,
//     refreshToken,
//   };
// };

export { createAdmin };
