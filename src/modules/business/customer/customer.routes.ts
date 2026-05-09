import { Router } from "express";
import { validate } from "@middlewares/validate.middleware";
import {
  getCustomerController,
  listCustomerConversationsController,
  listCustomersController,
  updateCustomerController,
} from "./customer.controller";
import {
  customerIdSchema,
  listCustomersSchema,
  updateCustomerSchema,
} from "./customer.validation";

const customerRoutes = Router();

customerRoutes.get("/", validate(listCustomersSchema), listCustomersController);
customerRoutes.get("/:id", validate(customerIdSchema), getCustomerController);
customerRoutes.patch("/:id", validate(updateCustomerSchema), updateCustomerController);
customerRoutes.get(
  "/:id/conversations",
  validate(customerIdSchema),
  listCustomerConversationsController,
);

export default customerRoutes;
