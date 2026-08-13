export type OrderAction = "CONFIRM" | "CANCEL";

export type OrderStatus = "AWAITING_CONFIRMATION" | "CONFIRMED" | "CANCELED";

export type OrderTemplateField =
  | "customerName"
  | "orderNumber"
  | "itemSummary"
  | "total"
  | "currency"
  | "shippingCity"
  | "shippingCountry";

export type CanonicalOrderCustomer = {
  name?: string;
  phone: string;
  locale?: "ar" | "en";
};

export type CanonicalOrderItem = {
  id: string;
  name: string;
  quantity: string;
  unitPrice: string;
  total: string;
};

export type CanonicalShippingAddress = {
  addressLine1?: string;
  addressLine2?: string;
  city?: string;
  state?: string;
  postalCode?: string;
  country?: string;
};

export type CanonicalOrder = {
  id: string;
  number: string;
  currency: string;
  total: string;
  customer: CanonicalOrderCustomer;
  items?: CanonicalOrderItem[];
  shippingAddress?: CanonicalShippingAddress;
  sourceStatus?: string;
  paymentMethod?: string;
  metadata?: Record<string, unknown>;
};

export type CanonicalOrderEvent = {
  schemaVersion: "1";
  eventId: string;
  eventType: "order.created";
  occurredAt: string;
  order: CanonicalOrder;
};

export type OrderActionInput = {
  businessProfileId: number;
  phoneNumberId: string;
  customerPhone: string;
  actionToken: string;
  inboundMessageId?: string;
  buttonTitle?: string;
  correlationId: string;
};

export type OrderConfirmationJob =
  | { type: "PROCESS_EVENT"; eventId: number; correlationId: string }
  | { type: "SEND_NOTIFICATION"; notificationId: number; correlationId: string }
  | ({ type: "PROCESS_ACTION" } & OrderActionInput)
  | { type: "SYNC_STORE"; syncId: number; correlationId: string };
