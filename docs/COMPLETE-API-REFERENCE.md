# MoveX Super App — Complete Backend API Reference & Integration Guide

This document is the authoritative integration manual for frontend/mobile developers connecting to the MoveX Unified Backend (`v2.0.0`). Every endpoint is **100% database-backed via PostgreSQL** with zero hardcoded/mock data.

Base URL: `http://127.0.0.1:4000` (or your deployed server host)  
Standard Headers:  
`Content-Type: application/json`  
`Authorization: Bearer <JWT_TOKEN>`

---

## 1. Single-Session Multi-Role Gateway (`/api/gateway`)
Implements Page 1 of the MoveX Architecture: Switch between Customer, Driver, Worker, Partner, and Admin without re-logging in.

| Method | Endpoint | Auth | Description |
| :--- | :--- | :--- | :--- |
| `GET` | `/api/gateway/context` | Required | Returns active mode, all eligible modes, active customer & provider orders, and wallet glance. |
| `POST` | `/api/gateway/switch-mode` | Required | Switches active session context (`{ targetMode: 'customer' \| 'driver' \| 'worker' \| 'partner' \| 'admin' }`) and returns a refreshed JWT. |

---

## 2. Authentication & Identity Management (`/api/auth` & `/api/users`)

| Method | Endpoint | Auth | Description |
| :--- | :--- | :--- | :--- |
| `POST` | `/api/auth/register` | Public | Register new user with roles (`customer`, `driver`, `worker`, `partner`, etc.) and auto-provisions a wallet. |
| `POST` | `/api/auth/login` | Public | Authenticates phone and password, returning multi-role JWT claims. |
| `GET` | `/api/users/me` | Required | Fetches user profile, roles, assigned provider vehicle details, and wallet balance. |
| `PATCH` | `/api/users/me` | Required | Updates profile name, email, etc. |

---

## 3. User Safety, OTP & Emergency SOS (`/api/safety`)
All verification records, KYC submissions, and SOS panic alerts are permanently saved in PostgreSQL.

| Method | Endpoint | Auth | Description |
| :--- | :--- | :--- | :--- |
| `POST` | `/api/safety/otp/send` | Public | Generates 6-digit OTP code, saved in `OtpVerification` DB table with a 5-minute TTL. |
| `POST` | `/api/safety/otp/verify` | Public | Validates OTP against PostgreSQL, marks `isVerified = true`, and activates user. |
| `POST` | `/api/safety/kyc/submit` | Required | Submits driver national ID, driving license, and vehicle plate to `ProviderKyc` DB table. |
| `GET` | `/api/safety/kyc/status` | Required | Returns current driver KYC approval status and submitted documents. |
| `POST` | `/api/safety/sos` | Required | High-priority Emergency SOS trigger: Persists incident to `SafetyAlert` DB table, broadcasts via WebSocket to admins, and returns emergency hotline numbers. |
| `GET` | `/api/safety/sos/alerts` | Admin | Fetches all recorded emergency incidents for operations dispatch. |

---

## 4. Real-Time Geospatial & Live Tracking (`/api/tracking`)

| Method | Endpoint | Auth | Description |
| :--- | :--- | :--- | :--- |
| `POST` | `/api/tracking/location` | Required | Provider sends live GPS ping (`{ lat, lng, speed, heading }`). Persists to `ProviderProfile` and broadcasts to `provider:{id}` and active `order:{id}` socket rooms. |
| `GET` | `/api/tracking/live-providers` | Public | Fetches all currently active and available drivers/workers on the road with coordinates for the map. |
| `GET` | `/api/tracking/order/:orderId` | Required | Live trip telemetry: Returns customer pickup/dropoff coords, driver real-time location, distance remaining in km, ETA countdown, and route waypoints. |
| `POST` | `/api/tracking/simulate-step` | Public/Test | Advances vehicle step along trip route (`{ orderId, stepRatio }`) and broadcasts real-time GPS update. |

---

## 5. Food Delivery Module (`/api/food`)
Fixed-price catalog flow. All write operations route strictly through Core Order Engine and execute an atomic 3-way wallet split.

| Method | Endpoint | Auth | Description |
| :--- | :--- | :--- | :--- |
| `GET` | `/api/food/vendors` | Public | Lists all active, open restaurant vendors from `Vendor` table. |
| `GET` | `/api/food/vendors/:id` | Public | Returns vendor details and active menu items (`MenuItem` table). |
| `POST` | `/api/food/cart/calculate` | Public | Calculates subtotal, delivery fee, and taxes from real menu item prices. |
| `POST` | `/api/food/checkout` | Customer | Places food order, advances to `matching`, and triggers atomic 3-way split ledger upon completion. |
| `POST` | `/api/food/orders` | Customer | Alias for `/checkout`. |

---

## 6. Ride Module (`/api/ride`)
Dynamic bidding flow. Does NOT create an order directly; creates a bidding request for nearby drivers.

| Method | Endpoint | Auth | Description |
| :--- | :--- | :--- | :--- |
| `POST` | `/api/ride/request` | Customer | Publishes ride bidding request to pool (`{ pickupLat, pickupLng, dropoffLat, dropoffLng, notes }`). |
| `POST` | `/api/ride/requests` | Customer | Alias for `/request`. |

---

## 7. Handyman Module (`/api/handyman`)
Service-category-aware bidding flow.

| Method | Endpoint | Auth | Description |
| :--- | :--- | :--- | :--- |
| `GET` | `/api/handyman/categories` | Public | Lists active handyman subcategories from database (`Plumbing`, `Electrical`, `Carpentry`). |
| `POST` | `/api/handyman/request` | Customer | Publishes task to handyman bidding pool with serviceCategoryId. |
| `POST` | `/api/handyman/requests` | Customer | Alias for `/request`. |

---

## 8. Moving Module (`/api/moving`)
Strict vehicle capacity ordering: `sedan (1) < pickup (2) < van (3) < small_truck (4) < large_truck (5)`.

| Method | Endpoint | Auth | Description |
| :--- | :--- | :--- | :--- |
| `GET` | `/api/moving/vehicle-types` | Public | Returns available vehicle types and capacity hierarchy. |
| `POST` | `/api/moving/orders` | Customer | Books moving job enforcing required vehicle capacity. |
| `POST` | `/api/moving/jobs` | Customer | Alias for `/orders`. |
| `GET` | `/api/moving/eligible-providers` | Required | Queries providers matching or exceeding the required vehicle capacity tier. |

---

## 9. Separate Bidding Layer (`/bidding` & `/api/bidding`)
Used exclusively by Ride and Handyman services. An `Offer` exists before an `Order` does.

| Method | Endpoint | Auth | Description |
| :--- | :--- | :--- | :--- |
| `POST` | `/bidding/requests` | Customer | Opens bidding request for nearby providers. |
| `GET` | `/bidding/requests/:id` | Required | Queries bidding request and all submitted driver offers. |
| `POST` | `/bidding/requests/:id/offers` | Provider | Driver/worker submits counter-offer (`{ amount, message }`). |
| `POST` | `/bidding/offers/:id/accept` | Customer | Customer accepts offer. Calls `orderEngine.createOrder()`, creates order row, and automatically marks all competing offers as `rejected`. |

---

## 10. Unified Order Engine (`/api/orders`)
The single authoritative gateway for all order state transitions.

| Method | Endpoint | Auth | Description |
| :--- | :--- | :--- | :--- |
| `GET` | `/api/orders/:id` | Required | Fetches order status, customer, provider, items, and timestamps. |
| `GET` | `/api/orders/my` | Required | Fetches customer's past and active orders. |
| `POST` | `/api/orders/:id/status` | Required | Advances order through state machine (`pending` -> `matching` -> `accepted` -> `in_progress` -> `completed`). Auto-triggers financial settlement on `completed`. |
| `POST` | `/api/orders/:id/cancel` | Required | Cancels order with a recorded cancellation reason. |

---

## 11. Concurrency-Safe Wallet & Financial Ledger (`/api/wallet`)
All financial operations run in atomic PostgreSQL transactions with zero-overdraft and idempotency guarantees.

| Method | Endpoint | Auth | Description |
| :--- | :--- | :--- | :--- |
| `GET` | `/api/wallet/balance` | Required | Returns current balance and currency (zero-overdraft enforced). |
| `GET` | `/api/wallet/transactions` | Required | Returns immutable double-entry ledger history (`topup`, `payout`, `commission`, `refund`). |
| `POST` | `/api/wallet/topup` | Required | Adds funds to wallet with reference ID idempotency check. |
| `POST` | `/api/wallet/payout/approve` | Admin Only | RBAC-guarded admin approval for driver/vendor payout disbursements. |

---

## 12. AI Suggestion Engine (`/ai` & `/api/ai`)
Intelligent recommendations using Claude Sonnet 4.6 with automatic database-driven Plan B heuristic fallback.

| Method | Endpoint | Auth | Description |
| :--- | :--- | :--- | :--- |
| `POST` | `/ai/suggest` | Public/Auth | Analyzes user context (`{ service_type, user_prompt, location }`) and returns structured JSON suggestions. Strictly read-only to orders/financials; logs every call to `AiSuggestionLog` DB table. |

---

## 13. Plan B Resilience & Fault Tolerance (`/api/resilience`)

| Method | Endpoint | Auth | Description |
| :--- | :--- | :--- | :--- |
| `GET` | `/api/resilience/status` | Public | Returns real-time health and state of all Circuit Breakers (`CLOSED`, `OPEN`, `HALF_OPEN`). |
| `POST` | `/api/resilience/simulate-failure` | Public/Test | Toggles artificial service outage (`ai_engine`, `maps_routing_service`, `notification_socket_dispatch`) to verify Plan B autonomous recovery. |
| `POST` | `/api/resilience/test-plan-b` | Public/Test | Runs automated test verifying that AI fallback, Haversine routing fallback, and vehicle capacity escalation trigger without crashing. |

---

## 14. Reviews & Ratings (`/api/reviews`)

| Method | Endpoint | Auth | Description |
| :--- | :--- | :--- | :--- |
| `POST` | `/api/reviews` | Customer | Submits 1-5 star review and comment for a completed order. |
| `GET` | `/api/reviews/provider/:providerId` | Public | Returns average rating and all reviews for a provider. |

---

## 15. Promotions & Coupons (`/api/promotions`)

| Method | Endpoint | Auth | Description |
| :--- | :--- | :--- | :--- |
| `POST` | `/api/promotions/apply` | Required | Validates coupon code against `Coupon` table and calculates discount amount. |
| `GET` | `/api/promotions/active` | Public | Lists all active non-expired promotional coupons. |

---

## 16. Platform Administration (`/api/admin`)
RBAC protected. Requires admin role.

| Method | Endpoint | Auth | Description |
| :--- | :--- | :--- | :--- |
| `GET` | `/api/admin/stats` | Admin | Real-time counts of total users, orders, and products. |
| `GET` | `/api/admin/orders` | Admin | Full order history with customer and product relations. |
| `PATCH` | `/api/admin/orders/:id` | Admin | Force advance order status. |
| `POST` | `/api/admin/categories` | Admin | Create new catalog category. |
| `POST` | `/api/admin/products` | Admin | Add new catalog product. |

---

## 17. Interactive Testing & Real-Time Tools
- **Swagger OpenAPI Documentation**: `http://127.0.0.1:4000/api-docs`
- **Web Testing Console & Live Map**: `http://127.0.0.1:4000/console` (or `http://127.0.0.1:4000/`)
- **Health Check**: `GET http://127.0.0.1:4000/health`
- **Automated Verification Test**: `npm run test:verify` (Runs all 15 architectural test suites).
