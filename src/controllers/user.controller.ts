import { Request, Response } from "express";
import {
  createUser,
  loginUser,
  getUserById,
  getAllUsers,
  updateUserRole,
  deactivateUser,
  reactivateUser,
  permanentlyDeleteUser,
} from "../services/user.service";
import {
  setAuthCookies,
  clearAuthCookies,
  // setUserRoleCookies,
} from "../middlewares/auth.middleware";

export const registerUser = async (req: Request, res: Response) => {
  try {
    const { name, email, password, role } = req.body;
    const user = await createUser(name, email, password, role);
    res.status(201).json({
      message: "User created successfully",
      user: {
        id: user.id,
        name: user.name,
        email: user.email,
        role: user.role,
      },
    });
  } catch (err: any) {
    res.status(400).json({ error: err.message });
  }
};

export const loginUserController = async (req: Request, res: Response) => {
  try {
    const { email, password } = req.body;
    const result = await loginUser(email, password);

    // Set HTTP-only cookies
    setAuthCookies(res, result.accessToken, result.refreshToken);
    // setUserRoleCookies(res, result.role, result.role);

    res.status(200).json({
      message: "User Login successful",
      accessToken: result.accessToken,
      user: {
        id: result.id,
        email: result.email,
        role: result.role,
      },
    });
  } catch (err: any) {
    res.status(400).json({ error: err.message });
  }
};

export const getCurrentUser = async (req: Request, res: Response) => {
  try {
    const userId = (req as any).user.id;
    const user = await getUserById(userId);
    if (!user) {
      return res.status(404).json({ error: "User not found" });
    }
    // Include the current accessToken from cookies to allow the frontend to stay in sync
    const accessToken = req.cookies?.accessToken || (req.headers.authorization?.startsWith("Bearer ") ? req.headers.authorization.split(" ")[1] : null);
    res.status(200).json({ ...user, accessToken });
  } catch (err: any) {
    res.status(400).json({ error: err.message });
  }
};

export const getUsers = async (req: Request, res: Response) => {
  try {
    const { includeInactive } = req.query;
    const users = await getAllUsers(includeInactive === "true");
    res.status(200).json(users);
  } catch (err: any) {
    res.status(400).json({ error: err.message });
  }
};

export const getUserByIdController = async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const { includeInactive } = req.query;
    const user = await getUserById(parseInt(id), includeInactive === "true");
    if (!user) {
      res.status(404).json({ error: "User not found" });
    }
    res.status(200).json(user);
  } catch (err: any) {
    res.status(400).json({ error: err.message });
  }
};
export const updateUser = async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const { role, name, email, plan, monthlyQuota } = req.body;
    const user = await updateUserRole(
      parseInt(id),
      role,
      name,
      email,
      plan,
      monthlyQuota,
    );
    res.status(200).json({
      message: "User updated successfully",
      user,
    });
  } catch (err: any) {
    res.status(400).json({ error: err.message });
  }
};

export const deactivateUserController = async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const user = await deactivateUser(parseInt(id));
    res.status(200).json({
      message: "User deactivated successfully",
      user,
    });
  } catch (err: any) {
    res.status(400).json({ error: err.message });
  }
};

export const reactivateUserController = async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const user = await reactivateUser(parseInt(id));
    res.status(200).json({
      message: "User reactivated successfully",
      user,
    });
  } catch (err: any) {
    res.status(400).json({ error: err.message });
  }
};

export const permanentlyDeleteUserController = async (
  req: Request,
  res: Response,
) => {
  try {
    const { id } = req.params;
    await permanentlyDeleteUser(parseInt(id));
    res.status(200).json({ message: "User permanently deleted successfully" });
  } catch (err: any) {
    res.status(400).json({ error: err.message });
  }
};

export const logoutUser = async (req: Request, res: Response) => {
  try {
    clearAuthCookies(res);
    res.status(200).json({ message: "Logged out successfully" });
  } catch (err: any) {
    res.status(400).json({ error: err.message });
  }
};
