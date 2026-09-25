# MoveX Backend v2.0 — Enterprise Architecture & Status Report

## 1. Executive Overview
The MoveX backend has been engineered as an enterprise-grade, clean-architecture Node.js + TypeScript + Express + Prisma + PostgreSQL platform. It combines on-demand food delivery, ride hailing, handyman services, and freight/relocation logistics with robust security, atomic double-entry wallet bookkeeping, decoupled domain events, geospatial proximity dispatching, and interactive OpenAPI documentation.

### Core Architectural Principle: Add, Don't Replace & Strict Core Separation
- Service modules (`food`, `ride`, `handyman`, `moving`) are thin adapters on top of the shared `core/` infrastructure (`auth`, `rbac`, `wallet`, `order-engine`, `sockets`, `notifications`, `chat`, `proximity`, `security`, `errors`, `events`, `ai`).
- No module imports from another module directly.
- Cross-module coordination is powered by the decoupled Domain Event Bus.
- Every state and financial mutation is guarded by strict state-machine rules and atomic DB transactions.

---

## 2. Component Inventory & Operational Status

### Core Infrastructure
| Component | Status | Architectural & Operational Highlights |
| :--- | :--- | :--- |
| **Security & Middleware (`core/security`)** | **Active & Hardened** | Helmet HTTP security headers, request ID tracing (`X-Request-Id`), 3-tier rate limiting (Global, Auth brute-force protection, Wallet protection), and Zod input validation. |
| **Error Handling (`core/errors`)** | **Active & Hardened** | Centralized Global Error Handler returning standard JSON envelopes (`{ success, data/error, meta }`). Safely maps Prisma constraints (`P2002`, `P2025`, `P2003`) and JWT errors without leaking stack traces. |
| **Auth (`core/auth`)** | **Fully Working** | JWT generation with multi-role claims array (`roles`), bcrypt password hashing, legacy single `role` backward compatibility. |
| **RBAC (`core/rbac`)** | **Fully Working** | Dynamic permission guard (`requirePermission()`) backed by in-memory TTL caching (5m). Blocks unauthorized callers with HTTP 403. |
| **Wallet & Ledger (`core/wallet`)** | **Fully Working & Concurrency-Safe** | Atomic `credit()`, `debit()`, `getBalance()`, `topupWallet()`, and `settleOrder()` in PostgreSQL transactions. Zero-overdraft guarantee, idempotency checking, and immutable pre/post balance audit trails. |
| **Order Engine (`core/order-engine`)** | **Fully Working** | Explicit state machine (`pending` -> `matching` -> `accepted` -> `in_progress` -> `completed` / `cancelled` / `disputed`). Prohibits illegal transitions, emits domain events, and auto-settles payments upon completion. |
| **Geospatial & Proximity (`core/proximity`)** | **Fully Working** | Mathematical Haversine great-circle engine for sub-millisecond distance calculation, dynamic transit ETA, and nearest available driver ranking. |
| **Sockets (`core/sockets`)** | **Fully Working** | Unified Socket.io server mounted on HTTP server with dynamic room subscriptions (`order:{id}`, `bidding:{id}`, `provider:{id}`, `user:{id}`). |
| **Domain Event Bus (`core/events`)** | **Fully Working** | Decoupled event emitter dispatching `order:status_changed`, `bidding:offer_accepted`, and `wallet:transaction` to sockets and notifications. |
| **AI Suggestion Engine (`core/ai`)** | **Fully Working** | `POST /ai/suggest` calling Claude Sonnet (`claude-sonnet-4-6`) with strict JSON output, logged to `AiSuggestionLog`. Read-only with respect to orders/wallets. |
| **Interactive Docs (`core/docs`)** | **Fully Working** | Interactive OpenAPI 3.0 specification served via Swagger UI at `http://127.0.0.1:4000/api-docs/`. |

### Modules & Bidding Layer
| Module | Status | Architectural & Operational Highlights |
| :--- | :--- | :--- |
| **Food (`modules/food`)** | **Fully Working** | Browse active vendors and menus, calculate dynamic cart totals, checkout via `orderEngine.createOrder()`. Auto-matches delivery courier. |
| **Ride (`modules/ride`)** | **Fully Working** | Initiates requests through `bidding` layer. Does NOT call `orderEngine.createOrder()` directly until offer acceptance. |
| **Handyman (`modules/handyman`)** | **Fully Working** | Dynamic `ServiceCategory` classification tree lookup (Plumbing, Electrical, Carpentry). Contractor bidding negotiation. |
| **Moving (`modules/moving`)** | **Fully Working** | Enforces vehicle capacity hierarchy (`sedan < pickup < van < small_truck < large_truck`). Strictly excludes smaller vehicles from larger jobs. |
| **Bidding Layer (`bidding/`)** | **Fully Working** | Customer opens request, providers submit competing offers, customer accepts one -> order created with agreed price and provider, other offers auto-rejected. |
| **Users (`modules/users`)** | **Fully Working** | View own profile (`GET /api/users/me`), wallet balance, active roles, and profile updates. |
| **Providers (`modules/providers`)** | **Fully Working** | Profile inspection (`GET /api/providers/me`), availability toggle (`PATCH /api/providers/me/availability`), and GPS updates (`POST /api/providers/me/location`). |
| **Reviews & Ratings (`modules/reviews`)** | **Fully Working** | Customer submits 1-5 star review on completed orders (`POST /api/reviews`). Aggregates provider average score. |
| **Promotions (`modules/promotions`)** | **Fully Working** | Coupon discount calculation engine (`POST /api/promotions/apply`) validating minimum order and percentage ceilings. |

---

## 3. Comprehensive Verification Test Results (Run on 2026-09-25)

The automated verification suite (`npm run test:verify`) passed 10 out of 10 suites against live PostgreSQL:

```
==================================================================
     MoveX Backend Complete Architectural Verification Suite      
==================================================================
  ✔ PASS : 1_food_order_wallet_settlement
  ✔ PASS : 2_ride_bidding_flow
  ✔ PASS : 3_moving_capacity_enforcement
  ✔ PASS : 4_ai_suggestion_and_logging
  ✔ PASS : 5_rbac_customer_403_guard
  ✔ PASS : 6_wallet_zero_overdraft
  ✔ PASS : 7_geospatial_proximity
  ✔ PASS : 8_reviews_and_ratings
  ✔ PASS : 9_coupon_promotions
  ✔ PASS : 10_swagger_ui_documentation
==================================================================
OVERALL STATUS: ALL 10 VERIFICATION SUITES PASSED
==================================================================
```

---

## 4. What Is Stubbed or Simplified
1. **Push & SMS Third-Party Credentials**: Clean `NotificationProvider` interface with in-console and database logging is active. Real Firebase (FCM) and Twilio API keys can be supplied directly in environment config.
2. **External Card Tokenization**: Internal double-entry ledger is complete and concurrency-safe; external Stripe/Paymob webhooks can be attached to call `wallet.topupWallet()`.
3. **AI Fallback Heuristic**: When `ANTHROPIC_API_KEY` is not present, an intelligent offline heuristic generates identical JSON schema responses, allowing reliable testing in air-gapped environments.

---

## 5. Top 5 Next Production Enhancements
1. **Connect Stripe / Paymob Webhook Handlers**: Route card charge webhooks into `wallet.topupWallet()` for credit card payments.
2. **Wire Live APNS / FCM Credentials**: Implement `FcmNotificationProvider` to push notifications to native iOS/Android devices.
3. **PostGIS Geometry Column Migration**: Convert latitude/longitude floats to PostgreSQL PostGIS `GEOMETRY(Point, 4326)` for spatial index lookups (`ST_DWithin`).
4. **Redis Telemetry Cache**: Pipe driver coordinate streams through Redis GeoSets for ultra-high-frequency tracking.
5. **Supervisor Web Dispute Console**: Provide frontend back-office screens for supervisors to review disputes and issue ledger refunds.
