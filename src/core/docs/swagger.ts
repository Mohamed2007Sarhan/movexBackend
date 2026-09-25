import swaggerUi from "swagger-ui-express";
import { Router } from "express";

const router = Router();

export const openApiSpec = {
  openapi: "3.0.3",
  info: {
    title: "MoveX Unified Platform Backend API",
    version: "2.0.0",
    description: `Production-Grade Unified Mobility, Food Delivery, Logistics & Handyman Platform API.
Designed following Clean Architecture with strict Shared Core isolation, RBAC role claims, atomic transactions, and realtime socket events.`,
    contact: {
      name: "MoveX Engineering Team",
      email: "engineering@movex.com",
    },
  },
  servers: [
    {
      url: "http://127.0.0.1:4000",
      description: "Local Development Server",
    },
  ],
  components: {
    securitySchemes: {
      BearerAuth: {
        type: "http",
        scheme: "bearer",
        bearerFormat: "JWT",
        description: "Standard JWT with embedded role claims and permissions.",
      },
    },
    schemas: {
      ApiResponse: {
        type: "object",
        properties: {
          success: { type: "boolean", example: true },
          data: { type: "object" },
          meta: {
            type: "object",
            properties: {
              timestamp: { type: "string", format: "date-time" },
              requestId: { type: "string" },
            },
          },
        },
      },
      ErrorResponse: {
        type: "object",
        properties: {
          success: { type: "boolean", example: false },
          error: {
            type: "object",
            properties: {
              code: { type: "string", example: "VALIDATION_ERROR" },
              message: { type: "string", example: "Invalid input parameters" },
              details: { type: "object" },
            },
          },
          meta: {
            type: "object",
            properties: {
              timestamp: { type: "string", format: "date-time" },
              requestId: { type: "string" },
            },
          },
        },
      },
      User: {
        type: "object",
        properties: {
          id: { type: "string" },
          name: { type: "string" },
          phone: { type: "string" },
          email: { type: "string", nullable: true },
          roles: { type: "array", items: { type: "string" } },
        },
      },
      Order: {
        type: "object",
        properties: {
          id: { type: "string" },
          serviceType: { type: "string", enum: ["food", "ride", "handyman", "moving"] },
          status: { type: "string", enum: ["pending", "matching", "accepted", "in_progress", "completed", "cancelled", "disputed"] },
          priceFinal: { type: "number", example: 45.0 },
          customerId: { type: "string" },
          providerId: { type: "string", nullable: true },
          requiredVehicleType: { type: "string", nullable: true, enum: ["sedan", "pickup", "van", "small_truck", "large_truck"] },
        },
      },
    },
  },
  security: [
    {
      BearerAuth: [],
    },
  ],
  paths: {
    "/health": {
      get: {
        summary: "System Health Check",
        tags: ["System"],
        responses: {
          200: { description: "API and Socket services healthy" },
        },
      },
    },
    "/api/auth/register": {
      post: {
        summary: "Register new user with role",
        tags: ["Auth"],
        security: [],
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: {
                type: "object",
                required: ["name", "phone", "password"],
                properties: {
                  name: { type: "string", example: "Mohamed Ali" },
                  phone: { type: "string", example: "01012345678" },
                  email: { type: "string", example: "user@movex.com" },
                  password: { type: "string", example: "Password123!" },
                  role: { type: "string", enum: ["customer", "driver", "worker", "partner"], default: "customer" },
                },
              },
            },
          },
        },
        responses: {
          200: { description: "User registered and JWT token returned" },
          409: { description: "Phone number already exists" },
        },
      },
    },
    "/api/auth/login": {
      post: {
        summary: "Authenticate user and receive token with role claims",
        tags: ["Auth"],
        security: [],
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: {
                type: "object",
                required: ["phone", "password"],
                properties: {
                  phone: { type: "string", example: "01000000001" },
                  password: { type: "string", example: "Password123!" },
                },
              },
            },
          },
        },
        responses: {
          200: { description: "Authentication successful" },
          401: { description: "Invalid credentials" },
        },
      },
    },
    "/api/users/me": {
      get: {
        summary: "Get current user profile, active roles, and wallet",
        tags: ["Users"],
        responses: {
          200: { description: "Profile data" },
          401: { description: "Unauthorized" },
        },
      },
    },
    "/api/providers/nearby": {
      get: {
        summary: "Find nearest providers using Haversine proximity engine",
        tags: ["Providers"],
        parameters: [
          { name: "lat", in: "query", required: true, schema: { type: "number" } },
          { name: "lng", in: "query", required: true, schema: { type: "number" } },
          { name: "categoryId", in: "query", schema: { type: "string" } },
          { name: "vehicleType", in: "query", schema: { type: "string" } },
          { name: "maxDistance", in: "query", schema: { type: "number", default: 30 } },
        ],
        responses: {
          200: { description: "Ranked list of providers sorted by distance" },
        },
      },
    },
    "/api/food/vendors": {
      get: {
        summary: "Browse active food vendors and menus",
        tags: ["Food"],
        responses: {
          200: { description: "List of open restaurants and groceries" },
        },
      },
    },
    "/api/food/checkout": {
      post: {
        summary: "Checkout food cart and match delivery courier",
        tags: ["Food"],
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: {
                type: "object",
                required: ["items", "address", "phone"],
                properties: {
                  items: {
                    type: "array",
                    items: {
                      type: "object",
                      properties: {
                        menuItemId: { type: "string" },
                        quantity: { type: "integer", default: 1 },
                      },
                    },
                  },
                  address: { type: "string" },
                  phone: { type: "string" },
                },
              },
            },
          },
        },
        responses: {
          201: { description: "Food order placed and sent to matching" },
        },
      },
    },
    "/bidding/requests": {
      post: {
        summary: "Open bidding request for Ride or Handyman (does NOT touch Order table)",
        tags: ["Bidding"],
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: {
                type: "object",
                required: ["serviceType", "serviceCategoryId"],
                properties: {
                  serviceType: { type: "string", enum: ["ride", "handyman"] },
                  serviceCategoryId: { type: "string" },
                  pickupLat: { type: "number" },
                  pickupLng: { type: "number" },
                  dropoffLat: { type: "number" },
                  dropoffLng: { type: "number" },
                  details: { type: "object" },
                },
              },
            },
          },
        },
        responses: {
          201: { description: "Bidding request opened, nearby drivers/workers notified" },
        },
      },
    },
    "/bidding/offers/{id}/accept": {
      post: {
        summary: "Accept winning bid (ONLY point where Order is created for ride/handyman)",
        tags: ["Bidding"],
        parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }],
        responses: {
          200: { description: "Order created with agreed price and provider, competing offers rejected" },
        },
      },
    },
    "/api/moving/jobs": {
      post: {
        summary: "Request moving job with strict vehicle capacity hierarchy enforcement",
        tags: ["Moving"],
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: {
                type: "object",
                required: ["requiredVehicleType", "pickupAddress", "dropoffAddress", "itemsDescription"],
                properties: {
                  requiredVehicleType: { type: "string", enum: ["sedan", "pickup", "van", "small_truck", "large_truck"] },
                  pickupAddress: { type: "string" },
                  dropoffAddress: { type: "string" },
                  itemsDescription: { type: "string" },
                  priceEstimate: { type: "number", default: 100 },
                },
              },
            },
          },
        },
        responses: {
          201: { description: "Moving order matched only to capable vehicles" },
        },
      },
    },
    "/ai/suggest": {
      post: {
        summary: "AI suggestion engine (Claude Sonnet 4.6 with strict JSON output)",
        tags: ["AI"],
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: {
                type: "object",
                required: ["context"],
                properties: {
                  context: {
                    type: "object",
                    properties: {
                      serviceType: { type: "string" },
                      location: { type: "object" },
                      orderHistory: { type: "array", items: { type: "string" } },
                      details: { type: "string" },
                    },
                  },
                },
              },
            },
          },
        },
        responses: {
          200: { description: "AI recommendation returned and logged to AiSuggestionLog" },
        },
      },
    },
    "/api/wallet/balance": {
      get: {
        summary: "Get current user wallet balance and currency",
        tags: ["Wallet"],
        responses: {
          200: { description: "Wallet balance" },
        },
      },
    },
    "/api/wallet/topup": {
      post: {
        summary: "Top up wallet balance with payment reference",
        tags: ["Wallet"],
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: {
                type: "object",
                required: ["amount"],
                properties: {
                  amount: { type: "number", example: 100.0 },
                  paymentMethod: { type: "string", default: "card" },
                  referenceId: { type: "string", example: "ref_pay_12345" },
                },
              },
            },
          },
        },
        responses: {
          200: { description: "Wallet balance credited" },
        },
      },
    },
    "/api/wallet/payout/approve": {
      post: {
        summary: "Approve provider payout (RBAC Guarded: wallet.payout.approve)",
        tags: ["Wallet"],
        responses: {
          200: { description: "Payout approved" },
          403: { description: "Forbidden: Customer role denied access" },
        },
      },
    },
  },
};

router.use("/", swaggerUi.serve, swaggerUi.setup(openApiSpec));

export default router;
