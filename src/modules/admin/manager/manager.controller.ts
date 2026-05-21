import { Request, Response } from "express";
import {
  createUser,
  getManagedUsers,
  getManagerDashboard,
  assignUserToManager,
  removeUserAssignment,
  getAllUserAssignments,
  canManageUser,
  deactivateUser,
  reactivateUser,
  getUserAnalytics,
} from "../../auth/user/user.service";
import {
  getBusinessProfileForManagedUser,
  updateBusinessProfileForManagedUser,
} from "@modules/business/profile/businessAccess.service";
import { AppError } from "@middlewares/errorHandler.middleware";

export const createManagedUser = async (req: Request, res: Response) => {
  const { name, email, password } = req.body;
  const creator = (req as any).user;

  const user = await createUser(name, email, password, "user");
  const assignment =
    creator.role === "manager"
      ? await assignUserToManager(creator.id, user.id, creator.id)
      : null;

  res.status(201).json({
    message: assignment
      ? "User created and assigned successfully"
      : "User created successfully",
    user,
    assignment,
  });
};

// Get manager's dashboard with overview of managed users
export const getManagerDashboardController = async (
  req: Request,
  res: Response
) => {
  const managerId = (req as any).user.id;
  const dashboard = await getManagerDashboard(managerId);
  res.status(200).json({ data: dashboard });
};

// Get all users managed by the current manager
export const getMyManagedUsers = async (req: Request, res: Response) => {
  const managerId = (req as any).user.id;
  const managedUsers = await getManagedUsers(managerId);
  res.status(200).json({ data: managedUsers });
};

// Get specific managed user details
export const getManagedUserById = async (req: Request, res: Response) => {
  const { id } = req.params;
  const managerId = (req as any).user.id;

  // Check if manager can access this user
  const canManage = await canManageUser(managerId, parseInt(id));
  if (!canManage) {
    throw new AppError("You can only access users assigned to you", 403);
  }

  const managedUsers = await getManagedUsers(managerId);
  const user = managedUsers.find((u) => u.user.id === parseInt(id));

  if (!user) {
    throw new AppError("User not found in your managed users", 404);
  }

  res.status(200).json({ data: user });
};

// Get analytics for a specific managed user
export const getManagedUserAnalytics = async (req: Request, res: Response) => {
  const { id } = req.params;
  const { days = 30 } = req.query;
  const managerId = (req as any).user.id;

  // Check if manager can access this user
  const canManage = await canManageUser(managerId, parseInt(id));
  if (!canManage) {
    throw new AppError("You can only access analytics for users assigned to you", 403);
  }

  const analytics = await getUserAnalytics(
    parseInt(id),
    parseInt(days as string)
  );
  res.status(200).json({ data: analytics });
};

// Deactivate a managed user
export const deactivateManagedUser = async (req: Request, res: Response) => {
  const { id } = req.params;
  const managerId = (req as any).user.id;

  // Check if manager can manage this user
  const canManage = await canManageUser(managerId, parseInt(id));
  if (!canManage) {
    throw new AppError("You can only manage users assigned to you", 403);
  }

  const user = await deactivateUser(parseInt(id));
  res.status(200).json({
    message: "User deactivated successfully",
    user,
  });
};

// Reactivate a managed user
export const reactivateManagedUser = async (req: Request, res: Response) => {
  const { id } = req.params;
  const managerId = (req as any).user.id;

  // Check if manager can manage this user
  const canManage = await canManageUser(managerId, parseInt(id));
  if (!canManage) {
    throw new AppError("You can only manage users assigned to you", 403);
  }

  const user = await reactivateUser(parseInt(id));
  res.status(200).json({
    message: "User reactivated successfully",
    user,
  });
};

export const getManagedBusinessProfile = async (
  req: Request,
  res: Response,
) => {
  const { id } = req.params;
  const managerId = (req as any).user.id;

  const businessProfile = await getBusinessProfileForManagedUser(
    managerId,
    Number(id),
  );

  res.status(200).json({ data: businessProfile });
};

export const updateManagedBusinessProfile = async (
  req: Request,
  res: Response,
) => {
  const { id } = req.params;
  const managerId = (req as any).user.id;

  const businessProfile = await updateBusinessProfileForManagedUser(
    managerId,
    Number(id),
    req.body,
  );

  res.status(200).json({
    message: "Business profile updated successfully",
    data: businessProfile,
  });
};

// Admin-only: Assign user to manager
export const assignUserToManagerController = async (
  req: Request,
  res: Response
) => {
  const { managerId, userId } = req.body;
  const assignedBy = (req as any).user.id;

  const assignment = await assignUserToManager(managerId, userId, assignedBy);
  res.status(201).json({
    message: "User assigned to manager successfully",
    data: assignment,
  });
};

// Admin-only: Get all user assignments
export const getAllUserAssignmentsController = async (
  req: Request,
  res: Response
) => {
  const assignments = await getAllUserAssignments();
  res.status(200).json({ data: assignments });
};

// Admin-only: Remove user assignment
export const removeUserAssignmentController = async (
  req: Request,
  res: Response
) => {
  const { id } = req.params;
  const removedBy = (req as any).user.id;

  const assignment = await removeUserAssignment(parseInt(id), removedBy);
  res.status(200).json({
    message: "User assignment removed successfully",
    data: assignment,
  });
};







