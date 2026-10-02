// Generated from docs/openapi.yaml and the integration guide. Do not edit.
export const ORDER_EVENT_JSON_SCHEMA = {
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "type": "object",
  "additionalProperties": false,
  "required": [
    "schemaVersion",
    "eventId",
    "eventType",
    "occurredAt",
    "order"
  ],
  "properties": {
    "schemaVersion": {
      "type": "string",
      "enum": [
        "1"
      ]
    },
    "eventId": {
      "type": "string",
      "minLength": 1,
      "pattern": "\\S"
    },
    "eventType": {
      "type": "string",
      "enum": [
        "order.created"
      ]
    },
    "occurredAt": {
      "type": "string",
      "format": "date-time"
    },
    "order": {
      "$ref": "#/$defs/CanonicalOrder"
    }
  },
  "$defs": {
    "CanonicalOrder": {
      "type": "object",
      "additionalProperties": false,
      "required": [
        "id",
        "number",
        "currency",
        "total",
        "customer"
      ],
      "properties": {
        "id": {
          "type": "string",
          "minLength": 1,
          "pattern": "\\S"
        },
        "number": {
          "type": "string",
          "minLength": 1,
          "pattern": "\\S"
        },
        "currency": {
          "type": "string",
          "pattern": "^[A-Z]{3}$",
          "enum": [
            "AED",
            "AFN",
            "ALL",
            "AMD",
            "ANG",
            "AOA",
            "ARS",
            "AUD",
            "AWG",
            "AZN",
            "BAM",
            "BBD",
            "BDT",
            "BGN",
            "BHD",
            "BIF",
            "BMD",
            "BND",
            "BOB",
            "BRL",
            "BSD",
            "BTN",
            "BWP",
            "BYN",
            "BZD",
            "CAD",
            "CDF",
            "CHF",
            "CLP",
            "CNY",
            "COP",
            "CRC",
            "CUC",
            "CUP",
            "CVE",
            "CZK",
            "DJF",
            "DKK",
            "DOP",
            "DZD",
            "EGP",
            "ERN",
            "ETB",
            "EUR",
            "FJD",
            "FKP",
            "GBP",
            "GEL",
            "GHS",
            "GIP",
            "GMD",
            "GNF",
            "GTQ",
            "GYD",
            "HKD",
            "HNL",
            "HRK",
            "HTG",
            "HUF",
            "IDR",
            "ILS",
            "INR",
            "IQD",
            "IRR",
            "ISK",
            "JMD",
            "JOD",
            "JPY",
            "KES",
            "KGS",
            "KHR",
            "KMF",
            "KPW",
            "KRW",
            "KWD",
            "KYD",
            "KZT",
            "LAK",
            "LBP",
            "LKR",
            "LRD",
            "LSL",
            "LYD",
            "MAD",
            "MDL",
            "MGA",
            "MKD",
            "MMK",
            "MNT",
            "MOP",
            "MRU",
            "MUR",
            "MVR",
            "MWK",
            "MXN",
            "MYR",
            "MZN",
            "NAD",
            "NGN",
            "NIO",
            "NOK",
            "NPR",
            "NZD",
            "OMR",
            "PAB",
            "PEN",
            "PGK",
            "PHP",
            "PKR",
            "PLN",
            "PYG",
            "QAR",
            "RON",
            "RSD",
            "RUB",
            "RWF",
            "SAR",
            "SBD",
            "SCR",
            "SDG",
            "SEK",
            "SGD",
            "SHP",
            "SLE",
            "SLL",
            "SOS",
            "SRD",
            "SSP",
            "STN",
            "SVC",
            "SYP",
            "SZL",
            "THB",
            "TJS",
            "TMT",
            "TND",
            "TOP",
            "TRY",
            "TTD",
            "TWD",
            "TZS",
            "UAH",
            "UGX",
            "USD",
            "UYU",
            "UZS",
            "VES",
            "VND",
            "VUV",
            "WST",
            "XAF",
            "XCD",
            "XCG",
            "XDR",
            "XOF",
            "XPF",
            "XSU",
            "YER",
            "ZAR",
            "ZMW",
            "ZWG",
            "ZWL"
          ]
        },
        "total": {
          "type": "string",
          "pattern": "^[0-9]+(?:\\.[0-9]+)?$"
        },
        "customer": {
          "$ref": "#/$defs/CanonicalOrderCustomer"
        },
        "items": {
          "type": "array",
          "items": {
            "$ref": "#/$defs/CanonicalOrderItem"
          }
        },
        "shippingAddress": {
          "$ref": "#/$defs/CanonicalShippingAddress"
        },
        "sourceStatus": {
          "type": "string",
          "minLength": 1,
          "pattern": "\\S"
        },
        "paymentMethod": {
          "type": "string",
          "minLength": 1,
          "pattern": "\\S"
        },
        "metadata": {
          "type": "object",
          "additionalProperties": true
        }
      }
    },
    "CanonicalOrderCustomer": {
      "type": "object",
      "additionalProperties": false,
      "required": [
        "phone"
      ],
      "properties": {
        "name": {
          "type": "string",
          "minLength": 1,
          "pattern": "\\S"
        },
        "phone": {
          "type": "string",
          "pattern": "^\\+[1-9][0-9]{1,14}$"
        },
        "locale": {
          "$ref": "#/$defs/OrderLocale"
        }
      }
    },
    "OrderLocale": {
      "type": "string",
      "enum": [
        "ar",
        "en"
      ]
    },
    "CanonicalOrderItem": {
      "type": "object",
      "additionalProperties": false,
      "required": [
        "id",
        "name",
        "quantity",
        "unitPrice",
        "total"
      ],
      "properties": {
        "id": {
          "type": "string",
          "minLength": 1,
          "pattern": "\\S"
        },
        "name": {
          "type": "string",
          "minLength": 1,
          "pattern": "\\S"
        },
        "quantity": {
          "type": "string",
          "pattern": "^[0-9]+(?:\\.[0-9]+)?$"
        },
        "unitPrice": {
          "type": "string",
          "pattern": "^[0-9]+(?:\\.[0-9]+)?$"
        },
        "total": {
          "type": "string",
          "pattern": "^[0-9]+(?:\\.[0-9]+)?$"
        }
      }
    },
    "CanonicalShippingAddress": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "addressLine1": {
          "type": "string",
          "minLength": 1,
          "pattern": "\\S"
        },
        "addressLine2": {
          "type": "string",
          "minLength": 1,
          "pattern": "\\S"
        },
        "city": {
          "type": "string",
          "minLength": 1,
          "pattern": "\\S"
        },
        "state": {
          "type": "string",
          "minLength": 1,
          "pattern": "\\S"
        },
        "postalCode": {
          "type": "string",
          "minLength": 1,
          "pattern": "\\S"
        },
        "country": {
          "type": "string",
          "minLength": 1,
          "pattern": "\\S"
        }
      }
    }
  }
};
export const ORDER_INTEGRATION_GUIDE = "# Connect a store to WKIL\n\nUse the generic API for schema version `1`. Each connection has a separate public\nintegration key and signing secret. Keep the secret on the store backend.\nTemplates are selected by business profile, WhatsApp account and locale. Stores\nsharing an account share its template configuration.\n\n## Setup without contacting customers\n\nFrom your server, send signed raw JSON to:\n\n- `POST /v1/order-integrations/:integrationKey/requirements` with\n  `{\"schemaVersion\":\"1\",\"locale\":\"ar\"}` (locale is optional).\n- `POST /v1/order-integrations/:integrationKey/validate` with a complete synthetic\n  order event. Include `Idempotency-Key` matching `eventId`.\n\nBoth endpoints allow configured inactive connections. Requirements reports the\nresolved template, its variable mapping and canonical source paths. Validation\nchecks the schema and every mapped field and returns a rendered preview. It\ndoes not save an order, reserve an event ID, send WhatsApp or invoke a callback.\nUse invented values such as the example below; never send production data for setup.\n\n```json\n{\"schemaVersion\":\"1\",\"eventId\":\"synthetic-order-1\",\"eventType\":\"order.created\",\"occurredAt\":\"2026-10-02T00:00:00Z\",\"order\":{\"id\":\"synthetic-1\",\"number\":\"TEST-1\",\"currency\":\"EGP\",\"total\":\"349.00\",\"customer\":{\"name\":\"Test Customer\",\"phone\":\"+201000000000\",\"locale\":\"en\"},\"items\":[{\"id\":\"item-1\",\"name\":\"Test Product\",\"quantity\":\"1\",\"unitPrice\":\"349.00\",\"total\":\"349.00\"}],\"shippingAddress\":{\"addressLine1\":\"Test Street 1\",\"city\":\"Cairo\",\"country\":\"Egypt\"},\"sourceStatus\":\"pending\",\"paymentMethod\":\"cod\"}}\n```\n\n## Signing and ingestion\n\nSerialize once. Calculate HMAC-SHA256 using the signing secret over\n`timestamp + \".\" + exactRawJsonBytes`. Send these headers:\n\n```text\nContent-Type: application/json\nX-Wkil-Timestamp: <Unix seconds>\nX-Wkil-Signature: v1=<hex HMAC digest>\nIdempotency-Key: <eventId>  # required for validate and events\n```\n\nTimestamp tolerance is five minutes. Regenerate timestamp/signature for each\nrequest. Current and previous secrets are supported during rotation. Setup is\nlimited to 30 authenticated requests per integration per minute; honor Retry-After.\n\nAfter validation, enable the connection and send real new events to\n`POST /v1/order-integrations/:integrationKey/events`. `202` acknowledges durable\nevent acceptance, with `accepted`, `duplicate` and `eventId`; WhatsApp delivery is\ntracked separately. Persist an outgoing event in the order transaction and send it\nfrom a bounded worker. After a timeout or crash, retry the same event ID and exact\npayload bytes. Never change attempted payloads or invent a new creation event ID\nto force a second notification. Successful duplicate acceptance does not repair\nan existing stored order. Use a separate authorized recovery process for old data.\n\n## Fields and actionable errors\n\nMoney and quantity are non-negative decimal **strings**, phones use E.164, and\nunknown properties are rejected. Optional fields may be omitted; supplied text\nmust be nonblank. A valid base schema does not guarantee template readiness.\nCountry strings such as `Egypt` and `EG` are accepted without inference.\n`shippingCountry` reads `order.shippingAddress.country`.\n`shippingFullAddress` reads the structured address and requires `addressLine1`;\ncity, state, postal code and country supplement it. Select **Shipping Address /\nعنوان الشحن** in WKIL to send an address. Existing country selections stay unchanged.\n\n```json\n{\"code\":\"TEMPLATE_DATA_INCOMPLETE\",\"message\":\"Some mapped template fields have no usable value\",\"retryable\":false,\"errors\":[{\"component\":\"body\",\"placeholder\":\"5\",\"field\":\"shippingCountry\",\"paths\":[\"order.shippingAddress.country\"],\"reason\":\"missing\"}]}\n```\n\n`200` validation means schemaValid/templateReady are true. `400` means invalid\ninput; `401` invalid/expired signature; `404` unknown connection; `409` missing\naccount/template; `422` missing mapped values; `429` rate limit; `503` temporary\nsetup failure. Correct permanent errors before retrying. Missing setup endpoints\nmean WKIL needs upgrading; never fall back to a live ingestion test.\n\nDownload the schema and this guide from authenticated WKIL setup. OpenAPI is the\nsource of truth; generated schema and TypeScript examples come from it.\n";
export const ORDER_EVENT_TYPESCRIPT_EXAMPLE = "export type paths = Record<string, never>;\nexport type webhooks = Record<string, never>;\nexport interface components {\n    schemas: {\n        CanonicalOrderEvent: {\n            /** @enum {string} */\n            schemaVersion: \"1\";\n            eventId: string;\n            /** @enum {string} */\n            eventType: \"order.created\";\n            /** Format: date-time */\n            occurredAt: string;\n            order: components[\"schemas\"][\"CanonicalOrder\"];\n        };\n        CanonicalOrder: {\n            id: string;\n            number: string;\n            /** @enum {string} */\n            currency: \"AED\" | \"AFN\" | \"ALL\" | \"AMD\" | \"ANG\" | \"AOA\" | \"ARS\" | \"AUD\" | \"AWG\" | \"AZN\" | \"BAM\" | \"BBD\" | \"BDT\" | \"BGN\" | \"BHD\" | \"BIF\" | \"BMD\" | \"BND\" | \"BOB\" | \"BRL\" | \"BSD\" | \"BTN\" | \"BWP\" | \"BYN\" | \"BZD\" | \"CAD\" | \"CDF\" | \"CHF\" | \"CLP\" | \"CNY\" | \"COP\" | \"CRC\" | \"CUC\" | \"CUP\" | \"CVE\" | \"CZK\" | \"DJF\" | \"DKK\" | \"DOP\" | \"DZD\" | \"EGP\" | \"ERN\" | \"ETB\" | \"EUR\" | \"FJD\" | \"FKP\" | \"GBP\" | \"GEL\" | \"GHS\" | \"GIP\" | \"GMD\" | \"GNF\" | \"GTQ\" | \"GYD\" | \"HKD\" | \"HNL\" | \"HRK\" | \"HTG\" | \"HUF\" | \"IDR\" | \"ILS\" | \"INR\" | \"IQD\" | \"IRR\" | \"ISK\" | \"JMD\" | \"JOD\" | \"JPY\" | \"KES\" | \"KGS\" | \"KHR\" | \"KMF\" | \"KPW\" | \"KRW\" | \"KWD\" | \"KYD\" | \"KZT\" | \"LAK\" | \"LBP\" | \"LKR\" | \"LRD\" | \"LSL\" | \"LYD\" | \"MAD\" | \"MDL\" | \"MGA\" | \"MKD\" | \"MMK\" | \"MNT\" | \"MOP\" | \"MRU\" | \"MUR\" | \"MVR\" | \"MWK\" | \"MXN\" | \"MYR\" | \"MZN\" | \"NAD\" | \"NGN\" | \"NIO\" | \"NOK\" | \"NPR\" | \"NZD\" | \"OMR\" | \"PAB\" | \"PEN\" | \"PGK\" | \"PHP\" | \"PKR\" | \"PLN\" | \"PYG\" | \"QAR\" | \"RON\" | \"RSD\" | \"RUB\" | \"RWF\" | \"SAR\" | \"SBD\" | \"SCR\" | \"SDG\" | \"SEK\" | \"SGD\" | \"SHP\" | \"SLE\" | \"SLL\" | \"SOS\" | \"SRD\" | \"SSP\" | \"STN\" | \"SVC\" | \"SYP\" | \"SZL\" | \"THB\" | \"TJS\" | \"TMT\" | \"TND\" | \"TOP\" | \"TRY\" | \"TTD\" | \"TWD\" | \"TZS\" | \"UAH\" | \"UGX\" | \"USD\" | \"UYU\" | \"UZS\" | \"VES\" | \"VND\" | \"VUV\" | \"WST\" | \"XAF\" | \"XCD\" | \"XCG\" | \"XDR\" | \"XOF\" | \"XPF\" | \"XSU\" | \"YER\" | \"ZAR\" | \"ZMW\" | \"ZWG\" | \"ZWL\";\n            total: string;\n            customer: components[\"schemas\"][\"CanonicalOrderCustomer\"];\n            items?: components[\"schemas\"][\"CanonicalOrderItem\"][];\n            shippingAddress?: components[\"schemas\"][\"CanonicalShippingAddress\"];\n            sourceStatus?: string;\n            paymentMethod?: string;\n            metadata?: {\n                [key: string]: unknown;\n            };\n        };\n        CanonicalOrderCustomer: {\n            name?: string;\n            phone: string;\n            locale?: components[\"schemas\"][\"OrderLocale\"];\n        };\n        /** @enum {string} */\n        OrderLocale: \"ar\" | \"en\";\n        CanonicalOrderItem: {\n            id: string;\n            name: string;\n            quantity: string;\n            unitPrice: string;\n            total: string;\n        };\n        CanonicalShippingAddress: {\n            addressLine1?: string;\n            addressLine2?: string;\n            city?: string;\n            state?: string;\n            postalCode?: string;\n            country?: string;\n        };\n    };\n    responses: never;\n    parameters: never;\n    requestBodies: never;\n    headers: never;\n    pathItems: never;\n}\nexport type $defs = Record<string, never>;\nexport type operations = Record<string, never>;\n\nexport type OrderEvent = components[\"schemas\"][\"CanonicalOrderEvent\"];\n";
