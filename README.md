# MoveX — Production-Grade Super App Unified Backend

> **MoveX** is an enterprise-scale, production-grade backend engine designed for multi-vertical on-demand super apps. It seamlessly unifies **Food & Grocery Delivery**, **Ride-Hailing & Bidding**, **Handyman & Home Maintenance Services**, and **Heavy Moving & Logistics** under a single, highly resilient micro-modular architecture.

---

## 🏛️ Architectural Overview & Philosophy

MoveX is strictly **backend-first** with zero compromise on reliability, financial safety, and fault tolerance:

1. **Zero Hardcoded Data (100% Dynamic Database-Backed)**:
   Every single entity — service categories, menu items, restaurants, commission percentages, KYC submissions, emergency alerts, wallet transactions, and fallback data — is persistently modeled and queried from PostgreSQL via Prisma ORM.

2. **Native UTF-8 PostgreSQL Storage**:
   Configured with native UTF-8 and standard C collation to seamlessly support Arabic, English, emojis, and international multilingual task descriptions and biographies.

3. **Double-Entry Financial Ledger with Driver Overdraft Facility**:
   - Strict zero-overdraft enforcement for standard customers ($Balance \ge 0$).
   - Authorized overdraft credit line of **1,500.00 EGP** for registered drivers and service workers, enabling smooth cash-on-delivery handling and platform commissions. Debits beyond -1,500.00 EGP are strictly blocked.
   - Full immutable audit trail recording `preBalance`, `postBalance`, `referenceId`, `senderName`, `recipientName`, and official `receiptId`.

4. **MoveX Plan B Universal Resilience Engine**:
   Every critical function is wrapped with autonomous circuit breaking (`CLOSED`, `OPEN`, `HALF_OPEN`) and deterministic fallbacks:
   - **AI Plan B**: Heuristic catalog & fare recommender if external LLMs experience latency or timeouts.
   - **Maps Plan B**: Autonomous Haversine road-curvature waypoints generator if external routing APIs are offline.
   - **Vehicle Plan B**: Upward capacity escalation (`sedan` $\to$ `pickup` $\to$ `van` $\to$ `small_truck` $\to$ `large_truck`).
   - **Notification Plan B**: Guaranteed database persistence and offline queueing if WebSocket disconnects.

5. **Single-Session Multi-Role Gateway**:
   Users maintain a single identity and seamlessly switch contexts between **Customer**, **Driver**, **Worker**, **Partner**, and **Admin** without logging out or losing active session state.

---

## 🚀 Core Functional Modules

### 1. 💳 Wallet & Financial Operations
- **P2P Transfers (`POST /api/wallet/send`, `POST /api/wallet/transfer`)**: Atomic money transfers between users via phone number or user ID.
- **Wallet Security PIN (`POST /api/wallet/set-pin`)**: 4–6 digit numeric PIN encryption using `bcryptjs` with mandatory verification before authorizing outbound transfers.
- **Money Requests (`POST /api/wallet/request-money`, `GET /api/wallet/requests`)**: Request funds from any registered phone number, with one-click fulfill (`POST /api/wallet/requests/:id/pay`) or decline (`POST /api/wallet/requests/:id/reject`).
- **Official Audit Receipts (`GET /api/wallet/transactions/:id/receipt`)**: Detailed verifiable receipts with unique `receiptId`, `referenceId`, timestamps, and double-entry balance verification.
- **Driver Overdraft Line**: Drivers and handymen operate with an authorized balance down to **-1,500.00 EGP**.

### 2. 🤖 AI Intelligence & Semantic Matcher
- **Free-Text Task Matcher (`POST /api/ai/match-providers`)**:
  - Understands colloquial Arabic descriptions (e.g. *"نقل عفش شقة محتاج عربية كبيرة لنقل العفش والدواليب"*).
  - Automatically identifies vehicle requirements: furniture (*"عفش"*) requires heavy vehicles (`large_truck`, `small_truck`, `van`) and **strictly excludes motorcycles and bicycles**.
  - Ranks database providers based on proximity, equipment matching, and trade skills with Arabic explanations.
- **Smart Registration Bio Parsing (`POST /api/ai/parse-bio`)**:
  - Automatically parses free-text provider descriptions into structured capabilities (vehicle type, profession, experience years, skill tags: `فك وتركيب`, `نجارة`, `سباكة`, `نقل ثقيل`).
- **Win-Win Price Mediation (`POST /api/ai/mediate-price`)**:
  - When a customer offers $X$ and a driver asks $Y$, AI analyzes route distance, expected duration, and platform benchmarks to mediate a fair compromise price satisfying both parties.

### 3. 🍔 Staged Food Delivery Lifecycle & Dynamic Commission
- **Staged Transitions**:
  1. Customer places order (`POST /api/food/orders`).
  2. Vendor accepts and prepares food (`POST /api/food/orders/:id/ready`).
  3. Proximity matching dispatches courier based on urgency:
     - `express`: Motorized vehicles (`motorcycle`, `sedan`).
     - `standard` / `relaxed`: Foot couriers (`walking`), bicycles, motorcycles.
  4. Courier confirms pickup (`POST /api/food/orders/:id/pickup`).
  5. Courier delivers food (`POST /api/food/orders/:id/courier-delivered`).
  6. Customer confirms receipt (`POST /api/food/orders/:id/customer-received`).
- **Dynamic Fee Split**:
  - 2% platform commission on food subtotal from the vendor.
  - 1% platform commission on delivery fee from the courier.
  - Payouts atomically deposited into respective vendor and courier wallets.

### 4. 🔨 Direct Handyman Services (Carpenter / Plumber / Electrician)
- Direct 2-party completion model without a delivery intermediary.
- Worker completes the job (`POST /api/handyman/orders/:id/worker-finish`).
- Customer inspects and confirms (`POST /api/handyman/orders/:id/customer-confirm`).
- Immediate atomic wallet settlement to worker minus platform commission.

### 5. 🛡️ User Verification, KYC & Emergency SOS
- **SMS OTP Verification**: 6-digit cryptographic verification (`POST /api/safety/otp/send`, `POST /api/safety/otp/verify`).
- **Driver KYC Management**: Submission of National ID, driver license, and vehicle plates (`POST /api/safety/kyc/submit`).
- **Emergency SOS Panic Button (`POST /api/safety/sos`)**:
  - Instantly logs critical incident with GPS coordinates in PostgreSQL.
  - Dispatches emergency notification across platform WebSockets and returns dedicated hotline (19999).

### 6. 👑 Enterprise Admin Suite (`/api/admin`)
- **System Statistics (`GET /api/admin/stats`)**: Real-time platform liquidity, active orders, vendor counts, and pending incidents.
- **Dynamic Categories (`POST/GET/PATCH/DELETE /api/admin/categories`)**: Add any new vertical (e.g., Pharmacy, Grocery, Flower Delivery) at runtime with zero code modification.
- **Dynamic Catalog (`POST/GET/PATCH/DELETE /api/admin/vendors`, `/api/admin/menu-items`)**: Merchant onboarding and menu management.
- **Audit Ledger (`GET /api/admin/wallet/ledger`)**: Company-wide financial double-entry transaction viewer.
- **Role Upgrade Review (`GET/POST /api/admin/role-requests`)**: Review user requests to become drivers or workers and approve with automated wallet overdraft line elevation.

---

## 📡 Complete API Reference

### 🔐 Authentication & Session Gateway
| Method | Endpoint | Description | Auth Level |
|---|---|---|---|
| `POST` | `/api/auth/register` | Register with multi-role, bio, profession, and AI capability extraction | Public |
| `POST` | `/api/auth/login` | Authenticate with phone and password | Public |
| `POST` | `/api/auth/request-role` | Submit role upgrade request (e.g. customer $\to$ driver/worker) | Authenticated |
| `GET` | `/api/gateway/context` | View active persona context and eligible switch modes | Authenticated |
| `POST` | `/api/gateway/switch-mode` | Instant context switch (customer/driver/worker/partner) | Authenticated |

### 💰 Wallet & P2P Ledger
| Method | Endpoint | Description | Auth Level |
|---|---|---|---|
| `GET` | `/api/wallet/balance` | Query current balance and overdraft limit | Authenticated |
| `GET` | `/api/wallet/transactions` | Query user's double-entry transactions history | Authenticated |
| `POST` | `/api/wallet/topup` | Credit wallet via credit card or digital payment | Authenticated |
| `POST` | `/api/wallet/send` | P2P transfer with mandatory PIN verification | Authenticated |
| `POST` | `/api/wallet/set-pin` | Configure or update 4-6 digit security PIN | Authenticated |
| `POST` | `/api/wallet/request-money` | Request payment from another user by phone number | Authenticated |
| `GET` | `/api/wallet/requests` | List incoming or outgoing money transfer requests | Authenticated |
| `POST` | `/api/wallet/requests/:id/pay` | Fulfill and pay transfer request with PIN | Authenticated |
| `POST` | `/api/wallet/requests/:id/reject` | Decline pending transfer request | Authenticated |
| `GET` | `/api/wallet/transactions/:id/receipt` | Download/lookup official immutable transaction receipt | Authenticated |

### 🧠 MoveX AI Engine
| Method | Endpoint | Description | Auth Level |
|---|---|---|---|
| `POST` | `/api/ai/match-providers` | Semantic task matcher with vehicle capacity filtering | Public / Auth |
| `POST` | `/api/ai/parse-bio` | NLP extraction of trade skills and vehicle types from bio | Public / Auth |
| `POST` | `/api/ai/mediate-price` | Win-win negotiation fair price calculator | Public / Auth |
| `POST` | `/api/ai/suggest` | Personalized contextual catalog & price suggestions | Authenticated |

### 🍔 Food & Grocery Delivery
| Method | Endpoint | Description | Auth Level |
|---|---|---|---|
| `POST` | `/api/food/orders` | Checkout food order with delivery urgency (`express`/`standard`) | Authenticated |
| `POST` | `/api/food/orders/:id/ready` | Restaurant marks order ready for courier pickup | Authenticated |
| `POST` | `/api/food/orders/:id/pickup` | Courier arrives at restaurant and collects order | Authenticated |
| `POST` | `/api/food/orders/:id/courier-delivered` | Courier arrives at customer dropoff location | Authenticated |
| `POST` | `/api/food/orders/:id/customer-received` | Customer confirms receipt $\to$ triggers 3-way split | Authenticated |

### 🔨 Handyman & Home Services
| Method | Endpoint | Description | Auth Level |
|---|---|---|---|
| `POST` | `/api/handyman/orders` | Book carpenter, plumber, or electrician | Authenticated |
| `POST` | `/api/handyman/orders/:id/worker-finish` | Worker marks maintenance job completed | Authenticated |
| `POST` | `/api/handyman/orders/:id/customer-confirm` | Customer verifies quality $\to$ triggers direct 2-way payout | Authenticated |

### 🚗 Ride Bidding & Heavy Moving
| Method | Endpoint | Description | Auth Level |
|---|---|---|---|
| `POST` | `/api/bidding/requests` | Broadcast ride or moving trip for driver bids | Authenticated |
| `POST` | `/api/bidding/offers` | Drivers submit competitive price offers | Authenticated |
| `POST` | `/api/bidding/offers/:id/accept` | Customer accepts offer $\to$ creates order and auto-rejects others | Authenticated |
| `POST` | `/api/bidding/requests/:id/mediate-price` | Trigger AI fair-price mediation for active bidding trip | Authenticated |

### 📍 Telemetry, Tracking & Emergency Safety
| Method | Endpoint | Description | Auth Level |
|---|---|---|---|
| `POST` | `/api/tracking/location` | Broadcast real-time driver GPS telemetry & heading | Authenticated |
| `GET` | `/api/tracking/live-providers` | Query active on-road drivers for live map display | Public |
| `GET` | `/api/tracking/order/:orderId` | Live order trip tracking with waypoints and ETA | Authenticated |
| `POST` | `/api/safety/otp/send` | Request 6-digit SMS OTP code | Public |
| `POST` | `/api/safety/otp/verify` | Verify SMS OTP code | Public |
| `POST` | `/api/safety/kyc/submit` | Upload National ID, driver license, and vehicle plate | Authenticated |
| `POST` | `/api/safety/sos` | Trigger emergency panic alert with live coordinates | Authenticated |

### 🛠️ Admin Management Suite (`/api/admin`)
| Method | Endpoint | Description | Auth Level |
|---|---|---|---|
| `GET` | `/api/admin/stats` | Platform liquidity and system performance metrics | Admin |
| `GET/POST/PATCH/DELETE`| `/api/admin/categories` | Manage vertical categories tree dynamically | Admin |
| `GET/POST/PATCH` | `/api/admin/vendors` | Manage registered restaurants and stores | Admin |
| `GET/POST/PATCH/DELETE`| `/api/admin/menu-items` | Manage catalog menu items and pricing | Admin |
| `GET` | `/api/admin/wallet/ledger` | Full audit ledger of all financial movements | Admin |
| `POST` | `/api/admin/wallet/adjust` | Administrative debit or credit adjustment with audit trail | Admin |
| `GET/PATCH` | `/api/admin/kyc` | Review and approve/reject driver KYC submissions | Admin |
| `GET/PATCH` | `/api/admin/safety/incidents` | Oversee and resolve emergency SOS alerts | Admin |
| `GET/POST` | `/api/admin/commission-rules` | Configure dynamic commission percentages per vertical | Admin |
| `GET/POST` | `/api/admin/role-requests` | Review and approve/reject user role upgrades | Admin |
| `GET/PATCH` | `/api/admin/system-config` | View and edit any platform limit or rule dynamically | Admin |
| `POST` | `/api/admin/system-config/bulk` | Batch update multiple configuration keys at once | Admin |
| `GET/POST` | `/api/admin/wallet/topup-requests` | Review, approve, or reject manual transfer top-ups | Admin |
| `GET` | `/api/admin/drivers/performance` | Driver ranking, on-time rates, and late deliveries count | Admin |
| `GET` | `/api/admin/deliveries/late` | Audit log of all late deliveries across the platform | Admin |

### 💳 Wallet Top-up with Payment Proof (Instapay / Vodafone Cash)
| Method | Endpoint | Description | Auth |
|---|---|---|---|
| `POST` | `/api/wallet/topup/initiate` | Returns platform payment number & creates pending request | Bearer |
| `POST` | `/api/wallet/topup/submit-proof` | Submits screenshot/text proof; AI verifies & auto-credits | Bearer |
| `GET` | `/api/wallet/topup/history` | List user's top-up requests and review statuses | Bearer |

---

## 🧪 Comprehensive Architectural Test Suite

MoveX includes an end-to-end automated verification test suite covering **all 28 architectural requirements**:

```bash
# Run the complete test suite
npm run test:verify
```

### Verification Matrix (28/28 Passing)
```
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
  ✔ PASS : 11_plan_b_resilience_engine
  ✔ PASS : 12_gateway_context_switching
  ✔ PASS : 13_live_location_tracking
  ✔ PASS : 14_safety_and_emergency_sos
  ✔ PASS : 15_interactive_test_console
  ✔ PASS : 16_p2p_wallet_and_double_entry_ledger
  ✔ PASS : 17_admin_dynamic_category_and_catalog
  ✔ PASS : 18_zero_hardcoded_dynamic_db_stats
  ✔ PASS : 19_food_staged_lifecycle_and_urgency_dispatch
  ✔ PASS : 20_driver_overdraft_credit_limit_1500
  ✔ PASS : 21_ai_fair_price_mediation
  ✔ PASS : 22_direct_handyman_two_party_settlement
  ✔ PASS : 23_wallet_send_pin_and_request_receipt
  ✔ PASS : 24_ai_bio_parsing_and_furniture_truck_matching
  ✔ PASS : 25_user_role_request_and_admin_approval
  ✔ PASS : 26_admin_system_config_control_panel
  ✔ PASS : 27_wallet_topup_proof_of_transfer
  ✔ PASS : 28_delivery_eta_and_late_detection
==================================================================
OVERALL STATUS: ALL 28 VERIFICATION SUITES PASSED (100%)
==================================================================
```

---

## 💻 Getting Started & Running MoveX

### Prerequisites
- Node.js $\ge$ 20.x
- Windows, macOS, or Linux

### Quick Start
```bash
# 1. Install dependencies
npm install

# 2. Start Embedded PostgreSQL (Port 5433)
npm run db:start

# 3. Synchronize Prisma Schema to movex_db
npx prisma db push

# 4. Seed database with initial roles, categories, and test personas
npm run seed

# 5. Start MoveX Backend Server (Port 4000)
npm start
```

### Interactive Dashboards
- **Web Testing Console & Live Map**: Open `http://127.0.0.1:4000/console` or `http://127.0.0.1:4000/` in your browser.
- **Interactive Swagger UI**: Open `http://127.0.0.1:4000/api-docs/` for live API exploration.

---

## 🔒 Security & Hardening
- **Helmet**: Full HTTP security headers protection (CSP, HSTS, X-Content-Type-Options).
- **Rate Limiting**: Tiered limiters preventing brute-force login and wallet flooding.
- **Bcrypt**: Salted password hashing (cost factor 10) and transaction PIN protection.
- **RBAC**: Cryptographic JWT authentication with fine-grained permission guards on every administrative and transactional route.
