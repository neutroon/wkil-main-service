import { Request, Response } from "express";
import {
  getCustomerForUser,
  listCustomerConversations,
  listCustomers,
  updateCustomerForUser,
} from "./customer.service";

export async function listCustomersController(req: Request, res: Response) {
  const userId = (req as any).user.id;
  const result = await listCustomers({
    userId,
    businessProfileId: req.query.businessProfileId
      ? Number(req.query.businessProfileId)
      : undefined,
    q: req.query.q as string | undefined,
    status: req.query.status as string | undefined,
    channel: req.query.channel as string | undefined,
    page: req.query.page ? Number(req.query.page) : undefined,
    limit: req.query.limit ? Number(req.query.limit) : undefined,
  });
  res.json(result);
}

export async function getCustomerController(req: Request, res: Response) {
  const userId = (req as any).user.id;
  const customer = await getCustomerForUser(userId, Number(req.params.id));
  res.json(customer);
}

export async function updateCustomerController(req: Request, res: Response) {
  const userId = (req as any).user.id;
  const customer = await updateCustomerForUser(
    userId,
    Number(req.params.id),
    req.body,
  );
  res.json(customer);
}

export async function listCustomerConversationsController(
  req: Request,
  res: Response,
) {
  const userId = (req as any).user.id;
  const conversations = await listCustomerConversations(
    userId,
    Number(req.params.id),
  );
  res.json({ data: conversations });
}
