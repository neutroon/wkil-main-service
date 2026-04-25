import bcrypt from "bcrypt";
import prisma from "../config/prisma";
import { AppError } from "../middlewares/errorHandler.middleware";

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

export { createAdmin };
