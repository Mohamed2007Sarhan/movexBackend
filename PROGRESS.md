# MoveX Backend Build Progress & Architecture Status

## Setup & Organization
- [x] Clone and consolidate repositories into clean root `/movex-workspace`
- [x] Delete legacy admin, mobile, and obsolete duplicate folders
- [x] Package renamed to `movex` (v2.0.0) with clean production scripts
- [x] Embedded PostgreSQL 18.4 runtime configured on port 5433 with native UTF-8 database (`movex_db`)

## Schema Extension (`prisma/schema.prisma`)
- [x] Add Role, UserRole, Permission, RolePermission tables; seeded: customer, driver, worker, partner, admin, supervisor
- [x] Add ServiceCategory (self-referencing parent_id tree); seeded: Food, Ride, Handyman (+Plumbing/Electrical/Carpentry), Moving
- [x] Add ProviderProfile (userId, serviceCategories m2m, vehicleType enum, isAvailable, currentLat/Lng, bio, profession, vehicleDetails, skills)
- [x] Reconcile Vendor, MenuItem, Category, Product models into unified catalog
- [x] Extend Order table: serviceType enum (food/ride/handyman/moving), serviceCategoryId, providerId, requiredVehicleType, status state-machine field, geospatial coordinates, staged timestamps
- [x] Add Offer table for separate bidding layer
- [x] Add WalletAccount (balance, overdraftLimit, securityPin), WalletTransaction (preBalance, postBalance, referenceId, senderName, recipientName, status), CommissionRule
- [x] Add WalletTransferRequest (requesterId, payerPhone, amount, note, status, settledAt)
- [x] Add RoleRequest (userId, requestedRole, profession, vehicleDetails, bio, status, adminNotes)
- [x] Add Notification, ChatMessage, Review, Coupon
- [x] Add AiSuggestionLog

## Core Services & Shared Architecture
- [x] RBAC middleware (`requirePermission()` guard, cached TTL in-memory)
- [x] Multi-role JWT claims & backward-compatible role claims
- [x] Concurrency-safe atomic wallet ledger (zero overdraft guarantee, 3-way food split, 2-way mobility split)
- [x] Order engine: `createOrder()`, `assignProvider()`, `advanceStatus()`, `cancelOrder()`
- [x] Unified Socket.io server with single-connection per user and room subscription events
- [x] Proximity & Geospatial engine (Haversine great-circle calculation & nearest provider ranking)
- [x] Rate limiting (3-tier: API, Auth brute-force, Wallet financial)
- [x] Interactive OpenAPI 3.0 / Swagger UI documentation at `/api-docs`

## Plan B Resilience Engine & Fault Tolerance (`src/core/resilience/`)
- [x] Universal `executeWithPlanB<T>()` wrapper with circuit breaking (`CLOSED`, `OPEN`, `HALF_OPEN`)
- [x] Plan B for AI: Smart deterministic heuristic suggestion engine if Claude LLM is unavailable
- [x] Plan B for Routing: Autonomous Haversine road-curvature waypoints generator if Maps API offline
- [x] Plan B for Vehicle Matching: Upward capacity escalation (`sedan` -> `pickup` -> `van` -> `small_truck` -> `large_truck`)
- [x] Plan B for Notifications: Guaranteed database persistence + offline queueing if socket push disconnects
- [x] Plan B for Database: Exponential backoff retry loop for transient locks and hiccups
- [x] Circuit breaker health inspector API (`GET /api/resilience/status`, `POST /api/resilience/simulate-failure`)

## Single-Session Multi-Role Gateway (`src/modules/gateway/`)
- [x] Page 1 Architecture Compliance: Seamless single-session context switching between Customer, Driver, Worker, Partner, and Admin without re-login
- [x] Multi-mode session context endpoint (`GET /api/gateway/context`)
- [x] Role-mode transition endpoint (`POST /api/gateway/switch-mode`) with dynamic token refreshing

## Real-Time Live Location Tracking & Simulation (`src/modules/tracking/`)
- [x] Live GPS telemetry broadcast (`POST /api/tracking/location`) updating database and emitting socket events
- [x] Active driver coordinates query (`GET /api/tracking/live-providers`)
- [x] Full trip telemetry with ETA, remaining km, and waypoints (`GET /api/tracking/order/:orderId`)
- [x] Step-by-step route progress simulation engine (`POST /api/tracking/simulate-step`)

## User Safety & Verification (`src/modules/safety/`)
- [x] 6-digit SMS OTP generation and validation (`POST /api/safety/otp/send`, `POST /api/safety/otp/verify`)
- [x] Driver KYC document submission and verification (`POST /api/safety/kyc/submit`)
- [x] High-priority Emergency SOS panic dispatch (`POST /api/safety/sos`) with live coordinates broadcasting

## Interactive Web Testing Console & Live Map Dashboard (`public/index.html`)
- [x] Web test console served directly at `http://127.0.0.1:4000/` and `/console`
- [x] One-click Instant Persona Switcher (Customer Ali, Driver Sedan, Driver Van, Admin)
- [x] Live Interactive Leaflet Map displaying Cairo, active providers, and trip route
- [x] Real-time trip simulation with live vehicle animation, remaining distance, and ETA countdown
- [x] Categorized API testing cards with live latency timer, status badges, and syntax-highlighted JSON viewer
- [x] Live WebSocket stream monitor displaying real-time incoming events and Plan B alerts

## Database Persistence & Audit Records
- [x] Zero hardcoded/static fallbacks: all catalog items, restaurants, categories, and AI fallbacks query live PostgreSQL database
- [x] Persistent `OtpVerification` model in PostgreSQL with indexed phone & code lookups
- [x] Persistent `ProviderKyc` model in PostgreSQL for driver national IDs, licenses, and vehicle plates
- [x] Persistent `SafetyAlert` model in PostgreSQL for SOS emergency dispatching with coordinates and status tracking
- [x] Atomic Peer-to-Peer (P2P) wallet transfer (`POST /api/wallet/transfer`, `POST /api/wallet/send`) with strict zero-overdraft verification and double-entry immutable audit ledger
- [x] Wallet Security PIN protection (`POST /api/wallet/set-pin`) with bcrypt encryption
- [x] Money Request Flow (`POST /api/wallet/request-money`, `GET /api/wallet/requests`, `POST /api/wallet/requests/:id/pay`, `POST /api/wallet/requests/:id/reject`)
- [x] Immutable Transaction Audit Receipts (`GET /api/wallet/transactions/:id/receipt`)
- [x] Role Upgrade Request & Admin Approval (`POST /api/auth/request-role`, `GET /api/admin/role-requests`, `POST /api/admin/role-requests/:id/approve`, `POST /api/admin/role-requests/:id/reject`)
- [x] AI Semantic Bio & Capability Parsing during registration (`POST /api/auth/register`, `POST /api/ai/parse-bio`)
- [x] Dynamic AI Task Provider Matcher with Heavy Vehicle Filtering (`POST /api/ai/match-providers`)
- [x] Dynamic Service Categories: Any new vertical (e.g., Grocery, Pharmacy, Courier, Laundry) can be added dynamically via Admin API with zero core code modifications
- [x] Enterprise Admin Management Suite (`/api/admin`):
  - `GET /api/admin/stats`: Real-time platform liquidity and system counters
  - `POST/GET/PATCH/DELETE /api/admin/categories`: Dynamic vertical category management
  - `POST/GET/PATCH /api/admin/vendors`: Merchant onboarding and operating state
  - `POST/GET/PATCH/DELETE /api/admin/menu-items`: Real-time dynamic catalog management
  - `GET /api/admin/wallet/ledger`: Universal financial double-entry ledger query
  - `POST /api/admin/wallet/adjust`: Platform manual debit/credit with audit reason
  - `GET/PATCH /api/admin/kyc`: Provider verification document review & approval
  - `GET/PATCH /api/admin/safety/incidents`: Real-time emergency SOS panic response management
  - `GET/POST /api/admin/commission-rules`: Dynamic service commission rates
  - `GET/POST /api/admin/role-requests`: User role upgrade request review & approval

## Verification Suites (`npm run test:verify`)
- [x] **Test 1**: Food Order End-to-End & 3-Way Wallet Settlement -> **PASSED**
- [x] **Test 2**: Ride Bidding Negotiation Flow -> **PASSED**
- [x] **Test 3**: Moving Order Vehicle Capacity Hierarchy -> **PASSED**
- [x] **Test 4**: AI Suggestion Service & AiSuggestionLog -> **PASSED**
- [x] **Test 5**: RBAC Security Guards (Customer gets 403 on admin-only route) -> **PASSED**
- [x] **Test 6**: Wallet Zero-Overdraft & Concurrency Safety -> **PASSED**
- [x] **Test 7**: Geospatial Proximity & Haversine Engine -> **PASSED**
- [x] **Test 8**: Reviews & Ratings Engine -> **PASSED**
- [x] **Test 9**: Promotions & Coupon Discount Engine -> **PASSED**
- [x] **Test 10**: Interactive OpenAPI Swagger UI -> **PASSED**
- [x] **Test 11**: MoveX Plan B Resilience Engine & Automated Fallbacks -> **PASSED**
- [x] **Test 12**: Single-Session Gateway Context Switcher -> **PASSED**
- [x] **Test 13**: Real-Time Live Location Tracking & Simulation -> **PASSED**
- [x] **Test 14**: User Safety Verification & Emergency SOS -> **PASSED**
- [x] **Test 15**: Interactive Testing Console & Web Dashboard -> **PASSED**
- [x] **Test 16**: Peer-to-Peer (P2P) Wallet Transfer with Double-Entry Ledger -> **PASSED**
- [x] **Test 17**: Admin Dynamic Category, Vendor & Catalog Item Creation -> **PASSED**
- [x] **Test 18**: Zero Hardcoded/Static Data (100% Dynamic DB Data) -> **PASSED**
- [x] **Test 19**: Food Staged Lifecycle & Urgency Courier Matching (Express vs Walking) -> **PASSED**
- [x] **Test 20**: Driver Overdraft Credit Facility (Negative Balance Limit up to -1500 EGP) -> **PASSED**
- [x] **Test 21**: MoveX AI Fair Price Negotiation & Win-Win Mediation -> **PASSED**
- [x] **Test 22**: Direct Handyman / Carpenter Two-Party Handshake & Settlement -> **PASSED**
- [x] **Test 23**: Complete Wallet Send, PIN Protection, Money Request & Audit Receipts -> **PASSED**
- [x] **Test 24**: AI Registration Bio Parsing & Dynamic Task Provider Matching (Furniture -> Truck) -> **PASSED**
- [x] **Test 25**: User Role Upgrade Request & Administrative Approval Workflow -> **PASSED**
- [x] **Test 26**: Admin SystemConfig Control Panel (Zero Hardcoded Values) -> **PASSED**
- [x] **Test 27**: Wallet Top-up via Manual Proof of Transfer (Instapay / Vodafone Cash + AI Verification) -> **PASSED**
- [x] **Test 28**: Delivery ETA Calculation & Driver Laziness Detection -> **PASSED**

## Business Flows & Architectural Highlights (MoveX v2.3.0)
- [x] **Food Staged Lifecycle**: Restaurant receives order -> Prepares food -> Marks ready -> Automated location-based dispatching of nearest courier matching required urgency:
  - `express`: Motorcycle / Sedan / Motorized vehicle for high speed
  - `standard` / `relaxed`: Foot couriers (walking) / Bicycles / Motorcycles
  - Two-Party Handshake: Courier marks delivered, Customer confirms receipt -> 3-way wallet settlement (2% platform fee from restaurant, 1% platform fee from courier).
- [x] **Driver Overdraft Credit Facility**: Driver/Worker accounts have an authorized credit limit allowing their balance to go negative down to **-1500 EGP** (or custom amount configured dynamically via Admin SystemConfig). Any debit breaching the limit is strictly blocked. Regular customers are enforced with zero-overdraft (balance >= 0).
- [x] **Admin SystemConfig Control Panel**: 100% of limits, fees, platform account numbers, and speed constants are dynamic in PostgreSQL and admin-controllable with zero code redeployment:
  - `GET /api/admin/system-config`: List all platform configurations
  - `PATCH /api/admin/system-config/:key`: Update any limit (overdraft, commission, speed, grace period)
  - `POST /api/admin/system-config/bulk`: Batch update multiple settings at once
- [x] **Smart Wallet Top-up with Payment Proof Verification (Instapay / Vodafone Cash)**:
  - User initiates top-up: `POST /api/wallet/topup/initiate` -> system displays dynamically configured Instapay / Vodafone Cash account number.
  - User transfers money outside the platform and submits screenshot / details: `POST /api/wallet/topup/submit-proof`.
  - Built-in AI proof verification checks amount match, account match, legitimate URL, and anti-fraud heuristics.
  - If AI confidence >= threshold -> automatically approves and credits user's wallet with immutable ledger entry.
  - If suspicious or low confidence -> routes to admin review queue (`GET/POST /api/admin/wallet/topup-requests`).
- [x] **Delivery ETA Calculation & Driver Laziness Detection**:
  - Distance computed via Haversine great-circle formula.
  - Travel time estimated based on vehicle type speed (`motorcycle`, `sedan`, `van`, `large_truck`, `walking`, `bicycle`) from SystemConfig, urgency multipliers, and buffer minutes.
  - Sets `estimatedDeliveryAt` and `etaMinutes` on order upon dispatch.
  - On delivery completion, automatically checks actual delivery timestamp against ETA + grace period.
  - If driver is late beyond grace period, order is marked `isLateDelivery = true` with `lateByMinutes`, and driver's `lateDeliveries` count increments on `ProviderProfile`.
  - Admin visibility via `GET /api/admin/drivers/performance` and `GET /api/admin/deliveries/late`.
- [x] **AI Fair Price Negotiation Mediation**: When Customer offers X and Driver asks Y, AI calculates trip distance, estimated time, and route benchmark to mediate a win-win fair compromise price with Arabic and English reasoning.
- [x] **Direct Handyman / Trade Services**: For Carpenter, Plumber, or Electrician bookings, no delivery middleman is involved. Worker marks work finished, Customer inspects and confirms -> immediate direct 2-party wallet settlement.
- [x] **Full Wallet Operations Suite**: P2P transfers with PIN authorization, money requests with one-click pay/reject, and immutable receipt audit lookups with pre/post balances.
- [x] **AI Semantic Capability Extraction & Dynamic Matching**: Free-text provider bios parsed automatically to detect vehicle types and trade skills. Customers describing arbitrary tasks (e.g. moving heavy furniture) are automatically matched with heavy trucks (`large_truck`), strictly excluding motorcycles.
- [x] **Self-Service Role Upgrade & Admin Approvals**: Users can request driver/worker status with profession and vehicle details, subject to administrator approval.

**Overall Status**: 28/28 Architectural Test Suites Passed (100%). System is fully operational, 100% dynamically driven from PostgreSQL, hardened with Plan B universal resilience, and production-grade.

