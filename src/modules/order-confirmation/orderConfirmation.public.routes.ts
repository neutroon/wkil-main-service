import { Router } from "express";
import { receiveOrderEvent } from "./orderConfirmation.public.controller";

const orderConfirmationPublicRoutes = Router();

orderConfirmationPublicRoutes.post("/:integrationKey/events", receiveOrderEvent);

export { orderConfirmationPublicRoutes };
export default orderConfirmationPublicRoutes;
