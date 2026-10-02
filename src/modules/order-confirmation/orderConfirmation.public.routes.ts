import { Router } from "express";
import { getSignedOrderRequirements, validateSignedOrderEvent } from "./orderConfirmation.setup.controller";
import { receiveOrderEvent } from "./orderConfirmation.public.controller";

const orderConfirmationPublicRoutes = Router();

orderConfirmationPublicRoutes.post("/:integrationKey/events", receiveOrderEvent);

orderConfirmationPublicRoutes.post("/:integrationKey/requirements", getSignedOrderRequirements);
orderConfirmationPublicRoutes.post("/:integrationKey/validate", validateSignedOrderEvent);

export { orderConfirmationPublicRoutes };
export default orderConfirmationPublicRoutes;
