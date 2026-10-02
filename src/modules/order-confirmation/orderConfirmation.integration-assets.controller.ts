import type { Request, Response } from "express";
import { listOrderTemplateFields } from "./orderConfirmation.fields";
import { ORDER_EVENT_JSON_SCHEMA, ORDER_INTEGRATION_GUIDE } from "./orderConfirmation.integration-assets.generated";

export function listTemplateFields(_req: Request, res: Response): void { res.json({ data: listOrderTemplateFields() }); }
export function downloadOrderSchema(_req: Request, res: Response): void {
  res.setHeader("Content-Disposition", 'attachment; filename="wkil-order-event.schema.json"');
  res.type("application/schema+json").send(JSON.stringify(ORDER_EVENT_JSON_SCHEMA, null, 2));
}
export function downloadIntegrationGuide(_req: Request, res: Response): void {
  res.setHeader("Content-Disposition", 'attachment; filename="wkil-store-integration.md"');
  res.type("text/markdown").send(ORDER_INTEGRATION_GUIDE);
}
