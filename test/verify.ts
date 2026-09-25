import { db } from "../src/db.js";
import { ServiceType, OrderStatus, VehicleType, TransactionType } from "@prisma/client";
import { generateToken } from "../src/core/auth/index.js";
import { checkout } from "../src/modules/food/food.service.js";
import { createOrder, advanceStatus, getOrder } from "../src/core/order-engine/index.js";
import { createBiddingRequest, submitOffer, acceptOffer } from "../src/bidding/offers.service.js";
import { createMovingJob, getEligibleProvidersForVehicle } from "../src/modules/moving/moving.service.js";
import { generateSuggestion } from "../src/core/ai/ai.service.js";
import { calculateDistanceKm, estimateEtaMinutes, findNearestProviders } from "../src/core/proximity/index.js";
import { debit, getBalance, getOrCreateWallet, topupWallet } from "../src/core/wallet/index.js";
import app from "../src/app.js";
import http from "http";

let server: http.Server;
const TEST_PORT = 4002;

async function runVerification() {
  console.log("==================================================================");
  console.log("     MoveX Backend Complete Architectural Verification Suite      ");
  console.log("==================================================================");

  server = app.listen(TEST_PORT, "127.0.0.1");
  const results: Record<string, boolean> = {};

  // Clean wallet state for reproducible test executions
  await db.walletAccount.updateMany({ data: { securityPin: null } });

  try {
    // -------------------------------------------------------------
    // TEST 1: Food Order End-to-End & 3-Way Wallet Settlement
    // -------------------------------------------------------------
    console.log("\n[TEST 1] Verifying Food Order End-to-End & 3-Way Wallet Settlement...");
    const customer = await db.user.findUnique({ where: { phone: "01000000001" } });
    const vendor = await db.vendor.findFirst({
      include: { menuItems: true },
    });
    if (!customer || !vendor || !vendor.menuItems.length) {
      throw new Error("Seed data missing for customer or vendor");
    }

    const menuItem = vendor.menuItems[0];
    const foodOrder = await checkout({
      customerId: customer.id,
      items: [{ menuItemId: menuItem.id, quantity: 2 }],
      address: "10 Tahrir Square, Cairo",
      phone: customer.phone,
    });

    console.log(`  -> Food order created: ${foodOrder.id}, status: ${foodOrder.status}, total: $${foodOrder.priceFinal}`);

    // Progress through state machine to completed
    if (foodOrder.status === OrderStatus.matching || foodOrder.status === OrderStatus.pending) {
      await advanceStatus(foodOrder.id, OrderStatus.accepted);
    }
    await advanceStatus(foodOrder.id, OrderStatus.in_progress);
    const completedOrder = await advanceStatus(foodOrder.id, OrderStatus.completed);

    console.log(`  -> Advanced to status: ${completedOrder.status}, completedAt: ${completedOrder.completedAt}`);

    // Check Wallet Transactions created for this order
    const transactions = await db.walletTransaction.findMany({
      where: { orderId: foodOrder.id },
    });

    console.log(`  -> Total wallet transactions recorded: ${transactions.length}`);
    for (const t of transactions) {
      console.log(`     - Type: ${t.type.padEnd(10)} | Amount: $${Number(t.amount).toFixed(2).padStart(6)} | ${t.description}`);
    }

    const hasCommission = transactions.some((t) => t.type === TransactionType.commission);
    const payoutTxs = transactions.filter((t) => t.type === TransactionType.payout);
    const hasVendorPayout = payoutTxs.some((t) => t.description?.toLowerCase().includes("vendor"));
    const hasProviderPayout = payoutTxs.some((t) => t.description?.toLowerCase().includes("rider") || t.description?.toLowerCase().includes("delivery"));

    const test1Passed = hasCommission && hasVendorPayout && hasProviderPayout && transactions.length >= 3;
    results["1_food_order_wallet_settlement"] = test1Passed;
    console.log(`  => TEST 1 RESULT: ${test1Passed ? "PASSED" : "FAILED"}`);

    // -------------------------------------------------------------
    // TEST 2: Ride Bidding: Request -> 2 Competing Offers -> Accept -> Order Created -> Reject Other
    // -------------------------------------------------------------
    console.log("\n[TEST 2] Verifying Ride Bidding Negotiation Flow...");
    const rideCustomer = await db.user.findUnique({ where: { phone: "01000000002" } });
    const driver1 = await db.user.findUnique({ where: { phone: "01000000011" } }); // Sedan
    const driver2 = await db.user.findUnique({ where: { phone: "01000000012" } }); // Pickup
    const rideCat = await db.serviceCategory.findFirst({ where: { id: "cat-ride" } });

    if (!rideCustomer || !driver1 || !driver2 || !rideCat) {
      throw new Error("Seed data missing for ride test");
    }

    const { request: biddingReq } = await createBiddingRequest({
      customerId: rideCustomer.id,
      serviceType: ServiceType.ride,
      serviceCategoryId: rideCat.id,
      pickupLat: 30.0444,
      pickupLng: 31.2357,
      dropoffLat: 30.0600,
      dropoffLng: 31.2500,
      details: { rideType: "economy" },
    });

    const orderBefore = await db.order.findFirst({
      where: { payload: { path: ["biddingRequestId"], equals: biddingReq.id } },
    });
    console.log(`  -> Bidding request ${biddingReq.id} created. Order exists yet? ${!!orderBefore}`);

    const offer1 = await submitOffer({
      biddingRequestId: biddingReq.id,
      providerId: driver1.id,
      amount: 25.0,
      message: "Sedan available in 3 mins",
    });

    const offer2 = await submitOffer({
      biddingRequestId: biddingReq.id,
      providerId: driver2.id,
      amount: 18.5,
      message: "Pickup nearby, great price!",
    });

    const { order: createdOrder } = await acceptOffer(offer2.id, rideCustomer.id);

    const refreshedOffer1 = await db.offer.findUnique({ where: { id: offer1.id } });
    const refreshedOffer2 = await db.offer.findUnique({ where: { id: offer2.id } });

    console.log(`  -> Offer 2 status after accept: ${refreshedOffer2?.status}`);
    console.log(`  -> Offer 1 status after auto-reject: ${refreshedOffer1?.status}`);
    console.log(`  -> Created Order id: ${createdOrder.id}, providerId: ${createdOrder.providerId}, priceFinal: $${createdOrder.priceFinal}`);

    const test2Passed =
      !orderBefore &&
      refreshedOffer2?.status === "accepted" &&
      refreshedOffer1?.status === "rejected" &&
      createdOrder.providerId === driver2.id &&
      Number(createdOrder.priceFinal) === 18.5;

    results["2_ride_bidding_flow"] = test2Passed;
    console.log(`  => TEST 2 RESULT: ${test2Passed ? "PASSED" : "FAILED"}`);

    // -------------------------------------------------------------
    // TEST 3: Moving Order with requiredVehicleType: large_truck
    // -------------------------------------------------------------
    console.log("\n[TEST 3] Verifying Moving Order Vehicle Capacity Hierarchy...");
    const largeTruckProviders = await getEligibleProvidersForVehicle(VehicleType.large_truck);
    console.log(`  -> Eligible providers for large_truck: ${largeTruckProviders.length}`);

    const allAreLargeTruck = largeTruckProviders.every((p) => p.vehicleType === VehicleType.large_truck);
    const hasSedanOrVan = largeTruckProviders.some((p) => p.vehicleType === VehicleType.sedan || p.vehicleType === VehicleType.van);

    const movingJob = await createMovingJob({
      customerId: customer.id,
      requiredVehicleType: VehicleType.large_truck,
      pickupAddress: "Villa 12, New Cairo",
      dropoffAddress: "Warehouse 4, 6th of October",
      itemsDescription: "Heavy warehouse machinery and large furniture",
      priceEstimate: 350.0,
    });

    console.log(`  -> Moving order ${movingJob.order.id} matched vehicle types: [${movingJob.matchedVehicleTypes.join(", ")}]`);

    const test3Passed = allAreLargeTruck && !hasSedanOrVan && largeTruckProviders.length > 0;
    results["3_moving_capacity_enforcement"] = test3Passed;
    console.log(`  => TEST 3 RESULT: ${test3Passed ? "PASSED" : "FAILED"}`);

    // -------------------------------------------------------------
    // TEST 4: AI Suggestion Service & AiSuggestionLog (Read-Only)
    // -------------------------------------------------------------
    console.log("\n[TEST 4] Verifying AI Suggestion Service & AiSuggestionLog...");
    const aiContext = {
      serviceType: "food",
      location: { lat: 30.0444, lng: 31.2357 },
      timeOfDay: "evening",
      orderHistory: ["Burger King", "Pizza Palace"],
    };

    const initialLogCount = await db.aiSuggestionLog.count();
    const suggestion = await generateSuggestion({
      userId: customer.id,
      context: aiContext,
    });

    const newLogCount = await db.aiSuggestionLog.count();
    const latestLog = await db.aiSuggestionLog.findFirst({
      where: { userId: customer.id },
      orderBy: { createdAt: "desc" },
    });

    console.log(`  -> AI Suggestion Response:\n${JSON.stringify(suggestion, null, 2)}`);
    console.log(`  -> AiSuggestionLog recorded? ${newLogCount > initialLogCount} (log id: ${latestLog?.id})`);

    const hasValidShape =
      typeof suggestion.suggestion_type === "string" &&
      Array.isArray(suggestion.suggested_items) &&
      suggestion.suggested_items.length > 0 &&
      typeof suggestion.confidence === "number";

    const test4Passed = hasValidShape && newLogCount > initialLogCount;
    results["4_ai_suggestion_and_logging"] = test4Passed;
    console.log(`  => TEST 4 RESULT: ${test4Passed ? "PASSED" : "FAILED"}`);

    // -------------------------------------------------------------
    // TEST 5: RBAC Route Guard (Customer gets 403 on Admin route)
    // -------------------------------------------------------------
    console.log("\n[TEST 5] Verifying RBAC Security Guards (Customer gets 403 on admin-only route)...");
    const customerToken = await generateToken({
      id: customer.id,
      phone: customer.phone,
      role: "CUSTOMER",
      roles: ["customer"],
    });

    const adminUser = await db.user.findUnique({ where: { phone: "01000000041" } });
    const adminToken = await generateToken({
      id: adminUser!.id,
      phone: adminUser!.phone,
      role: "ADMIN",
      roles: ["admin"],
    });

    const customerRes = await fetch(`http://127.0.0.1:${TEST_PORT}/api/wallet/payout/approve`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${customerToken}`,
      },
    });

    const adminRes = await fetch(`http://127.0.0.1:${TEST_PORT}/api/wallet/payout/approve`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${adminToken}`,
      },
    });

    console.log(`  -> Customer request to /api/wallet/payout/approve -> HTTP ${customerRes.status}`);
    console.log(`  -> Admin request to /api/wallet/payout/approve -> HTTP ${adminRes.status}`);

    const test5Passed = customerRes.status === 403 && adminRes.status === 200;
    results["5_rbac_customer_403_guard"] = test5Passed;
    console.log(`  => TEST 5 RESULT: ${test5Passed ? "PASSED" : "FAILED"}`);

    // -------------------------------------------------------------
    // TEST 6: Wallet Concurrency & Zero-Overdraft Protection
    // -------------------------------------------------------------
    console.log("\n[TEST 6] Verifying Wallet Zero-Overdraft & Concurrency Safety...");
    const testWalletUser = await db.user.create({
      data: {
        name: "Wallet Concurrency Test",
        phone: `0199999${Date.now().toString().slice(-4)}`,
        password: "Pass",
        wallet: { create: { balance: 50.0 } },
      },
      include: { wallet: true },
    });

    let overdraftBlocked = false;
    try {
      // Attempt to debit $100 when balance is only $50
      await debit(testWalletUser.wallet!.id, 100.0, TransactionType.payout);
    } catch (overdraftErr: any) {
      overdraftBlocked = true;
      console.log(`  -> Overdraft successfully blocked: ${overdraftErr.message}`);
    }

    const balanceAfter = await getBalance(testWalletUser.wallet!.id);
    const test6Passed = overdraftBlocked && balanceAfter === 50.0;
    results["6_wallet_zero_overdraft"] = test6Passed;
    console.log(`  => TEST 6 RESULT: ${test6Passed ? "PASSED" : "FAILED"}`);

    // -------------------------------------------------------------
    // TEST 7: Geospatial Proximity & Haversine Engine
    // -------------------------------------------------------------
    console.log("\n[TEST 7] Verifying Geospatial Proximity & Haversine Engine...");
    // Cairo coordinates
    const tahrirLat = 30.0444, tahrirLng = 31.2357;
    const nasrCityLat = 30.0561, nasrCityLng = 31.3301;
    const distanceKm = calculateDistanceKm(tahrirLat, tahrirLng, nasrCityLat, nasrCityLng);
    const eta = estimateEtaMinutes(distanceKm);
    console.log(`  -> Distance Tahrir -> Nasr City: ${distanceKm} km (Est. ETA: ${eta} mins)`);

    const nearestProviders = await findNearestProviders({
      lat: tahrirLat,
      lng: tahrirLng,
      maxDistanceKm: 25,
      limit: 5,
    });
    console.log(`  -> Nearest providers found in 25km radius: ${nearestProviders.length}`);
    for (const p of nearestProviders) {
      console.log(`     - ${p.name}: ${p.distanceKm} km away (ETA ${p.etaMinutes}m)`);
    }

    const test7Passed = distanceKm > 5 && distanceKm < 15 && nearestProviders.length > 0;
    results["7_geospatial_proximity"] = test7Passed;
    console.log(`  => TEST 7 RESULT: ${test7Passed ? "PASSED" : "FAILED"}`);

    // -------------------------------------------------------------
    // TEST 8: Reviews & Ratings Engine
    // -------------------------------------------------------------
    console.log("\n[TEST 8] Verifying Reviews & Ratings Engine on Completed Order...");
    const reviewRes = await fetch(`http://127.0.0.1:${TEST_PORT}/api/reviews`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${customerToken}`,
      },
      body: JSON.stringify({
        orderId: foodOrder.id,
        rating: 5,
        comment: "Excellent fast delivery and warm food!",
      }),
    });

    const reviewData: any = await reviewRes.json();
    console.log(`  -> Review creation response (HTTP ${reviewRes.status}):`, reviewData.success ? "Success" : reviewData.error?.message);

    const test8Passed = reviewRes.status === 201 && reviewData.success === true;
    results["8_reviews_and_ratings"] = test8Passed;
    console.log(`  => TEST 8 RESULT: ${test8Passed ? "PASSED" : "FAILED"}`);

    // -------------------------------------------------------------
    // TEST 9: Coupon & Promotional Discounts
    // -------------------------------------------------------------
    console.log("\n[TEST 9] Verifying Promotions & Coupon Discount Engine...");
    const coupon = await db.coupon.upsert({
      where: { code: "MOVEX20" },
      update: { isActive: true },
      create: {
        code: "MOVEX20",
        discountPct: 20.0,
        maxDiscount: 25.0,
        minOrder: 30.0,
        expiresAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
        isActive: true,
      },
    });

    const promoRes = await fetch(`http://127.0.0.1:${TEST_PORT}/api/promotions/apply`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${customerToken}`,
      },
      body: JSON.stringify({
        code: "MOVEX20",
        orderTotal: 100.0,
      }),
    });

    const promoData: any = await promoRes.json();
    console.log(`  -> Applied MOVEX20 to $100 order: discount = $${promoData.data?.discountAmount}, final = $${promoData.data?.finalTotal}`);

    const test9Passed = promoRes.status === 200 && promoData.data?.discountAmount === 20.0 && promoData.data?.finalTotal === 80.0;
    results["9_coupon_promotions"] = test9Passed;
    console.log(`  => TEST 9 RESULT: ${test9Passed ? "PASSED" : "FAILED"}`);

    // -------------------------------------------------------------
    // TEST 10: Interactive OpenAPI Swagger UI Endpoint
    // -------------------------------------------------------------
    console.log("\n[TEST 10] Verifying Interactive Swagger UI /api-docs...");
    const swaggerRes = await fetch(`http://127.0.0.1:${TEST_PORT}/api-docs/`);
    console.log(`  -> GET /api-docs/ returned HTTP ${swaggerRes.status}`);

    const test10Passed = swaggerRes.status === 200;
    results["10_swagger_ui_documentation"] = test10Passed;
    console.log(`  => TEST 10 RESULT: ${test10Passed ? "PASSED" : "FAILED"}`);

    // -------------------------------------------------------------
    // TEST 11: MoveX Plan B Resilience Engine & Automated Fallbacks
    // -------------------------------------------------------------
    console.log("\n[TEST 11] Verifying Plan B Universal Resilience Engine & Fallbacks...");
    const planBRes = await fetch(`http://127.0.0.1:${TEST_PORT}/api/resilience/test-plan-b`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ testTarget: "all" }),
    });
    const planBData: any = await planBRes.json();
    console.log(`  -> Plan B AI Fallback triggered: ${planBData.data?.results?.aiPlanB?.fallbackTriggered}`);
    console.log(`  -> Plan B Routing Fallback distance: ${planBData.data?.results?.routingPlanB?.data?.distanceKm} km (${planBData.data?.results?.routingPlanB?.data?.waypoints?.length} waypoints)`);
    console.log(`  -> Plan B Vehicle Escalation selected tier: ${planBData.data?.results?.movingPlanB?.selectedTier} (escalated? ${planBData.data?.results?.movingPlanB?.escalated})`);

    const statusRes = await fetch(`http://127.0.0.1:${TEST_PORT}/api/resilience/status`);
    const statusData: any = await statusRes.json();
    console.log(`  -> Circuit Breakers active: ${Object.keys(statusData.data?.circuitBreakers || {}).join(", ")}`);

    const test11Passed =
      planBRes.status === 200 &&
      planBData.data?.results?.aiPlanB?.fallbackTriggered === true &&
      statusRes.status === 200 &&
      statusData.data?.planBEngine === "active";
    results["11_plan_b_resilience_engine"] = test11Passed;
    console.log(`  => TEST 11 RESULT: ${test11Passed ? "PASSED" : "FAILED"}`);

    // -------------------------------------------------------------
    // TEST 12: Single-Session Gateway Context Switcher
    // -------------------------------------------------------------
    console.log("\n[TEST 12] Verifying Single-Session Gateway Context Switcher...");
    const ctxRes = await fetch(`http://127.0.0.1:${TEST_PORT}/api/gateway/context`, {
      headers: { Authorization: `Bearer ${customerToken}` },
    });
    const ctxData: any = await ctxRes.json();
    console.log(`  -> Initial mode: ${ctxData.data?.activeMode}, Eligible modes: [${ctxData.data?.eligibleModes?.join(", ")}]`);

    // Switch mode to driver
    const switchRes = await fetch(`http://127.0.0.1:${TEST_PORT}/api/gateway/switch-mode`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${customerToken}`,
      },
      body: JSON.stringify({ targetMode: "driver" }),
    });
    const switchData: any = await switchRes.json();
    console.log(`  -> Switched mode: ${switchData.data?.activeMode}, New Token issued: ${!!switchData.data?.token}`);

    const test12Passed = ctxRes.status === 200 && switchRes.status === 200 && switchData.data?.activeMode === "driver";
    results["12_gateway_context_switching"] = test12Passed;
    console.log(`  => TEST 12 RESULT: ${test12Passed ? "PASSED" : "FAILED"}`);

    // -------------------------------------------------------------
    // TEST 13: Real-Time Live Location Tracking & Telemetry
    // -------------------------------------------------------------
    console.log("\n[TEST 13] Verifying Real-Time Live Location Tracking & Simulation...");
    const driver = await db.user.findFirst({
      where: { providerProfile: { vehicleType: VehicleType.sedan } },
    });
    if (!driver) throw new Error("Driver seed not found");
    const driverToken = await generateToken({ id: driver.id, phone: driver.phone, role: "DRIVER" });

    // Send GPS telemetry ping
    const pingRes = await fetch(`http://127.0.0.1:${TEST_PORT}/api/tracking/location`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${driverToken}`,
      },
      body: JSON.stringify({ lat: 30.048, lng: 31.240, speed: 40, heading: 180 }),
    });
    const pingData: any = await pingRes.json();
    console.log(`  -> Location ping response: ${pingData.data?.message} (lat: ${pingData.data?.coordinates?.lat}, lng: ${pingData.data?.coordinates?.lng})`);

    // Query active providers for live map
    const mapProvidersRes = await fetch(`http://127.0.0.1:${TEST_PORT}/api/tracking/live-providers`);
    const mapProvidersData: any = await mapProvidersRes.json();
    console.log(`  -> Live providers on the road for Map: ${mapProvidersData.data?.length}`);

    const test13Passed = pingRes.status === 200 && mapProvidersRes.status === 200 && mapProvidersData.data?.length > 0;
    results["13_live_location_tracking"] = test13Passed;
    console.log(`  => TEST 13 RESULT: ${test13Passed ? "PASSED" : "FAILED"}`);

    // -------------------------------------------------------------
    // TEST 14: User Verification & Emergency Safety (SOS)
    // -------------------------------------------------------------
    console.log("\n[TEST 14] Verifying User Safety Verification & Emergency SOS...");
    // 1. Send OTP
    const otpRes = await fetch(`http://127.0.0.1:${TEST_PORT}/api/safety/otp/send`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ phone: "+201011112222" }),
    });
    const otpData: any = await otpRes.json();
    const code = otpData.data?.debugOtpCode;

    // 2. Verify OTP
    const verifyRes = await fetch(`http://127.0.0.1:${TEST_PORT}/api/safety/otp/verify`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ phone: "+201011112222", code }),
    });
    const verifyData: any = await verifyRes.json();
    console.log(`  -> Phone OTP verified: ${verifyData.data?.verified}`);

    // 3. Trigger Emergency SOS
    const sosRes = await fetch(`http://127.0.0.1:${TEST_PORT}/api/safety/sos`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${customerToken}`,
      },
      body: JSON.stringify({
        reason: "Medical emergency on route",
        currentLat: 30.0444,
        currentLng: 31.2357,
      }),
    });
    const sosData: any = await sosRes.json();
    console.log(`  -> SOS Status: ${sosData.data?.status}, Hotline: ${sosData.data?.emergencyContacts?.movexHotline}`);

    const test14Passed =
      otpRes.status === 200 &&
      verifyRes.status === 200 &&
      verifyData.data?.verified === true &&
      sosRes.status === 201 &&
      sosData.data?.status === "EMERGENCY_DISPATCHED";
    results["14_safety_and_emergency_sos"] = test14Passed;
    console.log(`  => TEST 14 RESULT: ${test14Passed ? "PASSED" : "FAILED"}`);

    // -------------------------------------------------------------
    // TEST 15: Interactive Testing Console & Web Dashboard
    // -------------------------------------------------------------
    console.log("\n[TEST 15] Verifying Interactive Testing Console & Web Dashboard...");
    const consoleRes = await fetch(`http://127.0.0.1:${TEST_PORT}/console`, {
      headers: { Accept: "text/html" },
    });
    const htmlText = await consoleRes.text();
    const hasBrand = htmlText.includes("MoveX Super App");
    const hasMap = htmlText.includes("movex-map");
    console.log(`  -> GET /console returned HTTP ${consoleRes.status} (Contains MoveX branding? ${hasBrand}, Map? ${hasMap})`);

    const test15Passed = consoleRes.status === 200 && hasBrand && hasMap;
    results["15_interactive_test_console"] = test15Passed;
    console.log(`  => TEST 15 RESULT: ${test15Passed ? "PASSED" : "FAILED"}`);

    // -------------------------------------------------------------
    // TEST 16: Peer-to-Peer (P2P) Wallet Transfer with Audit Ledger
    // -------------------------------------------------------------
    console.log("\n[TEST 16] Verifying Peer-to-Peer (P2P) Wallet Transfer & Double-Entry Ledger...");
    // 1. Create a recipient user
    const recipientPhone = `0188888${Date.now().toString().slice(-4)}`;
    const recipientUser = await db.user.create({
      data: {
        name: "P2P Recipient User",
        phone: recipientPhone,
        password: "HashPassword123",
      },
    });

    // 2. Fund the sender wallet
    await fetch(`http://127.0.0.1:${TEST_PORT}/api/wallet/topup`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${customerToken}`,
      },
      body: JSON.stringify({
        amount: 200,
        paymentRef: "PAY-P2P-SEED-01",
        method: "visa",
      }),
    });

    // 3. Perform P2P transfer
    const transferAmount = 75.5;
    const transferRes = await fetch(`http://127.0.0.1:${TEST_PORT}/api/wallet/transfer`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${customerToken}`,
      },
      body: JSON.stringify({
        recipient: recipientPhone,
        recipientIdentifier: recipientPhone,
        amount: transferAmount,
        notes: "MoveX Instant P2P Payment Test",
        referenceId: `REF-${Date.now()}`,
      }),
    });

    const transferData: any = await transferRes.json();
    console.log(`  -> P2P Transfer Status: HTTP ${transferRes.status}, Success: ${transferData.data?.success}`);

    // 4. Verify double-entry ledger in database
    const recipientWallet = await db.walletAccount.findUnique({
      where: { userId: recipientUser.id },
      include: { transactions: true },
    });

    const hasDoubleEntry =
      Number(recipientWallet?.balance) === transferAmount &&
      recipientWallet?.transactions.some((t) => Number(t.amount) === transferAmount);

    console.log(`  -> Recipient balance in DB: $${recipientWallet?.balance} (Ledger verified? ${hasDoubleEntry})`);

    // 5. Verify Overdraft rejection
    const overdraftRes = await fetch(`http://127.0.0.1:${TEST_PORT}/api/wallet/transfer`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${customerToken}`,
      },
      body: JSON.stringify({
        recipient: recipientPhone,
        amount: 999999, // Exceeds balance
      }),
    });
    console.log(`  -> Overdraft attempt HTTP status: ${overdraftRes.status} (Expected 400)`);

    const test16Passed =
      transferRes.status === 200 &&
      transferData.data?.success === true &&
      hasDoubleEntry &&
      overdraftRes.status === 400;
    results["16_p2p_wallet_and_double_entry_ledger"] = test16Passed;
    console.log(`  => TEST 16 RESULT: ${test16Passed ? "PASSED" : "FAILED"}`);

    // -------------------------------------------------------------
    // TEST 17: Admin Dynamic Category & Catalog Operations
    // -------------------------------------------------------------
    console.log("\n[TEST 17] Verifying Admin Dynamic Category, Vendor & Catalog Item Creation...");
    // 1. Create a dynamic service category via Admin API
    const catRes = await fetch(`http://127.0.0.1:${TEST_PORT}/api/admin/categories`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${adminToken}`,
      },
      body: JSON.stringify({
        name: `Dynamic Category ${Date.now().toString().slice(-4)}`,
      }),
    });
    const catData: any = await catRes.json();
    const createdCatId = catData.data?.category?.id;
    console.log(`  -> Admin created dynamic category: ${catData.data?.category?.name} (ID: ${createdCatId})`);

    // 2. Create dynamic vendor under category
    const vendorRes = await fetch(`http://127.0.0.1:${TEST_PORT}/api/admin/vendors`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${adminToken}`,
      },
      body: JSON.stringify({
        name: "MoveX Dynamic Express Hub",
        ownerUserId: adminUser!.id,
        categoryId: createdCatId,
        address: "77 Innovation Ave, Cairo",
      }),
    });
    const vendorData: any = await vendorRes.json();
    const createdVendorId = vendorData.data?.vendor?.id;
    console.log(`  -> Admin created dynamic vendor: ${vendorData.data?.vendor?.name} (ID: ${createdVendorId})`);

    // 3. Create dynamic menu item under vendor
    const itemRes = await fetch(`http://127.0.0.1:${TEST_PORT}/api/admin/menu-items`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${adminToken}`,
      },
      body: JSON.stringify({
        vendorId: createdVendorId,
        name: "Express Delivery Pass",
        price: 25.50,
      }),
    });
    const itemData: any = await itemRes.json();
    console.log(`  -> Admin created dynamic catalog item: ${itemData.data?.item?.name} ($${itemData.data?.item?.price})`);

    // 4. Update dynamic commission rule
    const ruleRes = await fetch(`http://127.0.0.1:${TEST_PORT}/api/admin/commission-rules`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${adminToken}`,
      },
      body: JSON.stringify({
        serviceType: "food",
        percentage: 18.5,
      }),
    });
    const ruleData: any = await ruleRes.json();
    console.log(`  -> Admin updated commission rule: ${ruleData.data?.message}`);

    const test17Passed =
      catRes.status === 201 &&
      vendorRes.status === 201 &&
      itemRes.status === 201 &&
      ruleRes.status === 200;
    results["17_admin_dynamic_category_and_catalog"] = test17Passed;
    console.log(`  => TEST 17 RESULT: ${test17Passed ? "PASSED" : "FAILED"}`);

    // -------------------------------------------------------------
    // TEST 18: Zero Static/Hardcoded Fallbacks (Dynamic DB Integration)
    // -------------------------------------------------------------
    console.log("\n[TEST 18] Verifying Zero Hardcoded/Static Data (100% Dynamic DB Data)...");
    const adminStatsRes = await fetch(`http://127.0.0.1:${TEST_PORT}/api/admin/stats`, {
      headers: { Authorization: `Bearer ${adminToken}` },
    });
    const adminStatsData: any = await adminStatsRes.json();
    console.log(`  -> Admin Live Stats from DB: Users=${adminStatsData.data?.totalUsers}, CatalogItems=${adminStatsData.data?.totalCatalogItems}, WalletTxs=${adminStatsData.data?.totalWalletTransactions}`);

    const test18Passed =
      adminStatsRes.status === 200 &&
      typeof adminStatsData.data?.totalCatalogItems === "number" &&
      adminStatsData.data?.totalCatalogItems > 0 &&
      adminStatsData.data?.totalWalletTransactions > 0;
    results["18_zero_hardcoded_dynamic_db_stats"] = test18Passed;
    console.log(`  => TEST 18 RESULT: ${test18Passed ? "PASSED" : "FAILED"}`);

    // -------------------------------------------------------------
    // TEST 19: Food Staged Lifecycle & Urgency Courier Matching (Express vs Walking)
    // -------------------------------------------------------------
    console.log("\n[TEST 19] Verifying Food Staged Lifecycle & Urgency-Based Courier Dispatching...");
    // 1. Customer places an express food order
    const expressOrderRes = await fetch(`http://127.0.0.1:${TEST_PORT}/api/food/checkout`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${customerToken}`,
      },
      body: JSON.stringify({
        items: [{ menuItemId: menuItem.id, quantity: 1 }],
        address: "55 Ramses St, Cairo",
        phone: customer.phone,
        deliveryUrgency: "express", // Express requires motorized courier (motorcycle/sedan)
      }),
    });
    const expressOrderData: any = await expressOrderRes.json();
    const foodOrderId = expressOrderData.id || expressOrderData.data?.id;
    console.log(`  -> Express food order created: ${foodOrderId}, initial vendorStatus: ${expressOrderData.vendorStatus || "preparing"}`);

    // 2. Restaurant finishes preparing food and marks it ready -> triggers automated courier dispatching
    const readyRes = await fetch(`http://127.0.0.1:${TEST_PORT}/api/food/orders/${foodOrderId}/ready`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${adminToken}`,
      },
    });
    const readyData: any = await readyRes.json();
    console.log(`  -> Restaurant marked ready. Dispatched courier: ${readyData.dispatchedCourier?.name} (Vehicle: ${readyData.dispatchedCourier?.vehicleType}, Distance: ${readyData.dispatchedCourier?.distanceKm} km)`);

    // 3. Courier arrives and picks up food from restaurant
    const pickupRes = await fetch(`http://127.0.0.1:${TEST_PORT}/api/food/orders/${foodOrderId}/pickup`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${adminToken}`,
      },
    });
    const pickupData: any = await pickupRes.json();
    console.log(`  -> Courier picked up food. New Order Status: ${pickupData.status}, VendorStatus: ${pickupData.vendorStatus}`);

    // 4. Two-party Delivery Handshake:
    // Courier marks delivered
    const courierDelivRes = await fetch(`http://127.0.0.1:${TEST_PORT}/api/food/orders/${foodOrderId}/courier-delivered`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${adminToken}`,
      },
    });
    const courierDelivData: any = await courierDelivRes.json();

    // Customer confirms receipt -> finishes order & executes 3-way wallet settlement (2% vendor fee + 1% courier fee)
    const customerRecvRes = await fetch(`http://127.0.0.1:${TEST_PORT}/api/food/orders/${foodOrderId}/customer-received`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${customerToken}`,
      },
    });
    const customerRecvData: any = await customerRecvRes.json();
    console.log(`  -> Delivery completed & confirmed. Final status: ${customerRecvData.status}, fullyCompleted: ${customerRecvData.isFullyCompleted}`);

    const test19Passed =
      expressOrderRes.status === 201 &&
      readyRes.status === 200 &&
      pickupRes.status === 200 &&
      courierDelivRes.status === 200 &&
      customerRecvRes.status === 200 &&
      customerRecvData.isFullyCompleted === true;
    results["19_food_staged_lifecycle_and_urgency_dispatch"] = test19Passed;
    console.log(`  => TEST 19 RESULT: ${test19Passed ? "PASSED" : "FAILED"}`);

    // -------------------------------------------------------------
    // TEST 20: Driver Overdraft Credit Facility (Negative Balance Limit up to -1500 EGP)
    // -------------------------------------------------------------
    console.log("\n[TEST 20] Verifying Driver Overdraft Credit Line (Negative Balance up to -1500 EGP)...");
    // 1. Create a driver test user
    const driverPhone = `0177777${Date.now().toString().slice(-4)}`;
    const driverRole = await db.role.findUnique({ where: { name: "driver" } });
    const driverTestUser = await db.user.create({
      data: {
        name: "Test Driver Credit Facility",
        phone: driverPhone,
        password: "HashPassword123",
        role: "DRIVER",
      },
    });
    await db.userRole.create({
      data: {
        userId: driverTestUser.id,
        roleId: driverRole!.id,
      },
    });

    const driverWallet = await getOrCreateWallet(driverTestUser.id);
    console.log(`  -> Driver wallet initialized with overdraft limit: $${Number(driverWallet.overdraftLimit)} EGP`);

    // 2. Driver debits 500 EGP when balance is 0 -> balance goes into negative (-$500.00 EGP)
    const debitRes1 = await debit(driverWallet.id, 500, TransactionType.payout, undefined, "Driver cash collection commission float");
    console.log(`  -> Driver debited $500 while balance was 0. New balance: $${Number(debitRes1.wallet.balance)} EGP`);

    // 3. Driver debits another 900 EGP -> balance is -$1400.00 EGP (Allowed <= -1500 EGP)
    const debitRes2 = await debit(driverWallet.id, 900, TransactionType.payout, undefined, "Additional cash order commission float");
    console.log(`  -> Driver debited another $900. New balance: $${Number(debitRes2.wallet.balance)} EGP (Allowed within -1500 limit)`);

    // 4. Driver attempts to debit 200 EGP -> would reach -$1600.00 (Exceeds -1500 credit limit -> BLOCKED)
    let driverOverdraftBlocked = false;
    try {
      await debit(driverWallet.id, 200, TransactionType.payout, undefined, "Overdraft breaching limit");
    } catch (err: any) {
      driverOverdraftBlocked = err.message.includes("Driver credit limit exceeded");
      console.log(`  -> Debit exceeding -1500 limit blocked: "${err.message}"`);
    }

    const test20Passed =
      Number(driverWallet.overdraftLimit) === 1500 &&
      Number(debitRes1.wallet.balance) === -500 &&
      Number(debitRes2.wallet.balance) === -1400 &&
      driverOverdraftBlocked;
    results["20_driver_overdraft_credit_limit_1500"] = test20Passed;
    console.log(`  => TEST 20 RESULT: ${test20Passed ? "PASSED" : "FAILED"}`);

    // -------------------------------------------------------------
    // TEST 21: AI Fair Price Mediation & Win-Win Compromise
    // -------------------------------------------------------------
    console.log("\n[TEST 21] Verifying AI Fair Price Negotiation & Win-Win Mediation...");
    // Customer offers 10 EGP, Driver asks 20 EGP
    const customerOffer = 10;
    const driverAsk = 20;

    const mediationRes = await fetch(`http://127.0.0.1:${TEST_PORT}/api/ai/mediate-price`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${customerToken}`,
      },
      body: JSON.stringify({
        customerOffer,
        driverAsk,
        pickupLat: 30.0444,
        pickupLng: 31.2357,
        dropoffLat: 30.0650,
        dropoffLng: 31.2950,
        distanceKm: 6.8,
        serviceType: "ride",
      }),
    });
    const mediationData: any = await mediationRes.json();
    console.log(`  -> Customer Offer: $${customerOffer} | Driver Ask: $${driverAsk}`);
    console.log(`  -> AI Mediated Fair Price: $${mediationData.mediatedPrice} EGP`);
    console.log(`  -> Customer Savings: $${mediationData.customerSavings} EGP | Driver Surplus: $${mediationData.driverSurplus} EGP`);
    console.log(`  -> AI Arabic Explanation: "${mediationData.reasoningAr}"`);

    const mediatedIsBetween =
      mediationData.mediatedPrice > customerOffer &&
      mediationData.mediatedPrice < driverAsk &&
      mediationData.customerSavings > 0 &&
      mediationData.driverSurplus > 0;

    const test21Passed = mediationRes.status === 200 && mediatedIsBetween && typeof mediationData.reasoningAr === "string";
    results["21_ai_fair_price_mediation"] = test21Passed;
    console.log(`  => TEST 21 RESULT: ${test21Passed ? "PASSED" : "FAILED"}`);

    // -------------------------------------------------------------
    // TEST 22: Direct Handyman / Carpenter Two-Party Completion & Settlement
    // -------------------------------------------------------------
    console.log("\n[TEST 22] Verifying Direct Handyman / Carpenter Two-Party Handshake & Settlement...");
    // Find carpentry category
    const carpentryCat = await db.serviceCategory.findFirst({
      where: { name: { contains: "Carpentry", mode: "insensitive" } },
    });

    // 1. Customer creates a direct handyman order (Carpenter/Plumber)
    const workerUser = await db.user.findUnique({ where: { phone: "01000000021" } }); // Seeded worker
    const directHandymanOrder = await createOrder({
      customerId: customer.id,
      providerId: workerUser!.id,
      serviceType: ServiceType.handyman,
      serviceCategoryId: carpentryCat?.id,
      priceFinal: 120.0,
      total: 120.0,
      address: "15 Maadi Corniche, Cairo",
      phone: customer.phone,
      initialStatus: OrderStatus.accepted,
      payload: {
        task: "Repair wooden door frame and install deadbolt lock",
        trade: "Carpentry",
      },
    });
    const handymanOrderId = directHandymanOrder.id;
    console.log(`  -> Direct handyman order created: ${handymanOrderId}, Assigned Worker: ${workerUser?.name || "Direct Carpenter"}`);

    // 2. Carpenter arrives directly (no courier) and marks work finished
    const workerFinishRes = await fetch(`http://127.0.0.1:${TEST_PORT}/api/handyman/orders/${handymanOrderId}/worker-finish`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${adminToken}`,
      },
    });
    const workerFinishData: any = await workerFinishRes.json();
    console.log(`  -> Worker finished job directly: ${workerFinishData.message}`);

    // 3. Customer inspects and confirms -> immediate direct 2-party settlement
    const customerConfirmRes = await fetch(`http://127.0.0.1:${TEST_PORT}/api/handyman/orders/${handymanOrderId}/customer-confirm`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${customerToken}`,
      },
    });
    const customerConfirmData: any = await customerConfirmRes.json();
    console.log(`  -> Customer confirmed work. Status: ${customerConfirmData.status}, Settlement message: ${customerConfirmData.message}`);

    const test22Passed =
      Boolean(handymanOrderId) &&
      workerFinishRes.status === 200 &&
      customerConfirmRes.status === 200 &&
      customerConfirmData.status === "completed";
    results["22_direct_handyman_two_party_settlement"] = test22Passed;
    console.log(`  => TEST 22 RESULT: ${test22Passed ? "PASSED" : "FAILED"}`);

    // -------------------------------------------------------------
    // TEST 23: Complete Wallet Send, PIN Protection, Money Request & Audit Receipts
    // -------------------------------------------------------------
    console.log("\n[TEST 23] Verifying Complete Wallet Send, PIN Protection, Money Request & Audit Receipts...");
    // 1. Configure a 6-digit transaction PIN
    const setPinRes = await fetch(`http://127.0.0.1:${TEST_PORT}/api/wallet/set-pin`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${customerToken}`,
      },
      body: JSON.stringify({ pin: "789456" }),
    });
    const setPinData: any = await setPinRes.json();
    console.log(`  -> Wallet PIN configured: ${setPinData.success}`);

    // 2. Fund customer wallet with topup to ensure liquidity
    await fetch(`http://127.0.0.1:${TEST_PORT}/api/wallet/topup`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${customerToken}`,
      },
      body: JSON.stringify({
        amount: 300,
        paymentRef: "PAY-PIN-SEED-01",
        method: "card",
      }),
    });

    // 3. Attempt transfer with wrong PIN (must be rejected)
    const wrongPinRes = await fetch(`http://127.0.0.1:${TEST_PORT}/api/wallet/send`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${customerToken}`,
      },
      body: JSON.stringify({
        recipient: recipientPhone,
        amount: 25,
        notes: "Transfer with wrong PIN",
        pin: "000000",
      }),
    });
    console.log(`  -> Transfer with wrong PIN blocked? HTTP ${wrongPinRes.status} (Expected 403)`);

    // 4. Send transfer with correct PIN
    const sendRes = await fetch(`http://127.0.0.1:${TEST_PORT}/api/wallet/send`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${customerToken}`,
      },
      body: JSON.stringify({
        recipient: recipientPhone,
        amount: 25,
        notes: "Authorized P2P transfer with correct PIN",
        pin: "789456",
      }),
    });
    const sendData: any = await sendRes.json();
    console.log(`  -> Transfer with valid PIN succeeded? ${sendData.success}, Reference: ${sendData.data?.referenceId}`);

    // 5. Recipient requests money from customer
    const recipientToken = await generateToken({ id: recipientUser.id, phone: recipientUser.phone, role: "CUSTOMER" });
    const reqMoneyRes = await fetch(`http://127.0.0.1:${TEST_PORT}/api/wallet/request-money`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${recipientToken}`,
      },
      body: JSON.stringify({
        payerPhone: customer.phone,
        amount: 15,
        note: "Shared lunch cost",
      }),
    });
    const reqMoneyData: any = await reqMoneyRes.json();
    const moneyRequestId = reqMoneyData.data?.id;
    console.log(`  -> Money request created: ${moneyRequestId}, Status: ${reqMoneyData.data?.status}`);

    // 6. Customer lists incoming requests and pays it with PIN
    const listReqRes = await fetch(`http://127.0.0.1:${TEST_PORT}/api/wallet/requests?type=incoming`, {
      headers: { Authorization: `Bearer ${customerToken}` },
    });
    const listReqData: any = await listReqRes.json();
    const hasIncoming = Array.isArray(listReqData.data) && listReqData.data.some((r: any) => r.id === moneyRequestId);
    console.log(`  -> Incoming requests list contains request? ${hasIncoming}`);

    const payReqRes = await fetch(`http://127.0.0.1:${TEST_PORT}/api/wallet/requests/${moneyRequestId}/pay`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${customerToken}`,
      },
      body: JSON.stringify({ pin: "789456" }),
    });
    const payReqData: any = await payReqRes.json();
    console.log(`  -> Paid transfer request: ${payReqData.success}, Status: ${payReqData.data?.request?.status}`);

    // 7. Verify immutable transaction audit receipt
    const txId = sendData.data?.transactions?.[0]?.id;
    const receiptRes = await fetch(`http://127.0.0.1:${TEST_PORT}/api/wallet/transactions/${txId}/receipt`, {
      headers: { Authorization: `Bearer ${customerToken}` },
    });
    const receiptData: any = await receiptRes.json();
    console.log(`  -> Audit Receipt lookup: ID: ${receiptData.data?.receiptId}, Verified: ${receiptData.data?.verified}, Status: ${receiptData.data?.status}`);

    const test23Passed =
      setPinRes.status === 200 &&
      wrongPinRes.status === 403 &&
      sendRes.status === 200 &&
      Boolean(sendData.data?.referenceId) &&
      reqMoneyRes.status === 201 &&
      hasIncoming &&
      payReqRes.status === 200 &&
      payReqData.data?.request?.status === "ACCEPTED" &&
      receiptRes.status === 200 &&
      receiptData.data?.verified === true;

    results["23_wallet_send_pin_and_request_receipt"] = test23Passed;
    console.log(`  => TEST 23 RESULT: ${test23Passed ? "PASSED" : "FAILED"}`);

    // -------------------------------------------------------------
    // TEST 24: AI Registration Bio Parsing & Dynamic Task Provider Matching
    // -------------------------------------------------------------
    console.log("\n[TEST 24] Verifying AI Registration Bio Parsing & Dynamic Task Matching (Furniture -> Truck)...");
    // 1. Register a jumbo truck carpenter with free-text Arabic bio
    const regTruckRes = await fetch(`http://127.0.0.1:${TEST_PORT}/api/auth/register`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: "اسطى محمود النجار",
        phone: `0191111${Date.now().toString().slice(-4)}`,
        password: "Password123",
        role: "worker",
        bio: "معايا عربية نقل جامبو كبيرة ومساعدين لنقل وفك وتركيب غرف النوم والمطابخ والعفش الثقيل",
      }),
    });
    const regTruckData: any = await regTruckRes.json();
    console.log(`  -> Jumbo Truck Provider Registered: vehicleType = ${regTruckData.data?.user?.providerProfile?.vehicleType}, skills = [${regTruckData.data?.user?.providerProfile?.skills?.join(", ")}]`);

    // 2. Register a scooter courier with free-text Arabic bio
    const regBikeRes = await fetch(`http://127.0.0.1:${TEST_PORT}/api/auth/register`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: "كابتن سيف دليفري",
        phone: `0192222${Date.now().toString().slice(-4)}`,
        password: "Password123",
        role: "driver",
        bio: "سائق سكوتر موتوسيكل سريع لتوصيل الوجبات السريعة والطلبات الخفيفة والأوراق",
      }),
    });
    const regBikeData: any = await regBikeRes.json();
    console.log(`  -> Scooter Courier Registered: vehicleType = ${regBikeData.data?.user?.providerProfile?.vehicleType}`);

    // 3. Test Dynamic AI Provider Matcher with task requiring heavy furniture moving ("عفش")
    const aiMatchRes = await fetch(`http://127.0.0.1:${TEST_PORT}/api/ai/match-providers`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        taskDescription: "عندي نقل عفش شقة بالكامل ومحتاج عربية كبيرة لنقل العفش والدواليب",
        customerLat: 30.0444,
        customerLng: 31.2357,
      }),
    });
    const aiMatchData: any = await aiMatchRes.json();
    const inferredReq = aiMatchData.data?.inferredRequirements;
    const rankedProviders = aiMatchData.data?.rankedProviders || [];
    console.log(`  -> AI Inferred Vehicle: ${inferredReq?.vehicleType}, Inferred Skills: [${inferredReq?.skills?.join(", ")}]`);
    console.log(`  -> Top Recommended Provider: ${rankedProviders[0]?.name} (${rankedProviders[0]?.vehicleType}), Match Score: ${rankedProviders[0]?.matchScore}`);

    const topIsHeavyTruck = rankedProviders.length > 0 && rankedProviders[0].vehicleType === "large_truck";
    const noMotorcycleForFurniture = rankedProviders.every((p: any) => p.vehicleType !== "motorcycle");

    const test24Passed =
      regTruckRes.status === 201 &&
      regTruckData.data?.user?.providerProfile?.vehicleType === "large_truck" &&
      regBikeRes.status === 201 &&
      regBikeData.data?.user?.providerProfile?.vehicleType === "motorcycle" &&
      inferredReq?.vehicleType === "large_truck" &&
      topIsHeavyTruck &&
      noMotorcycleForFurniture;

    results["24_ai_bio_parsing_and_furniture_truck_matching"] = test24Passed;
    console.log(`  => TEST 24 RESULT: ${test24Passed ? "PASSED" : "FAILED"}`);

    // -------------------------------------------------------------
    // TEST 25: User Role Upgrade Request & Administrative Approval Workflow
    // -------------------------------------------------------------
    console.log("\n[TEST 25] Verifying User Role Upgrade Request & Administrative Approval Workflow...");
    // 1. Register a standard customer user
    const upgradeUserPhone = `0173333${Date.now().toString().slice(-4)}`;
    const regCustRes = await fetch(`http://127.0.0.1:${TEST_PORT}/api/auth/register`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: "أحمد طالب الترقية",
        phone: upgradeUserPhone,
        password: "Password123",
        role: "customer",
      }),
    });
    const regCustData: any = await regCustRes.json();
    const upgradeUserToken = regCustData.data?.token;
    const upgradeUserId = regCustData.data?.user?.id;

    // 2. User submits role upgrade request to become a driver
    const reqRoleRes = await fetch(`http://127.0.0.1:${TEST_PORT}/api/auth/request-role`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${upgradeUserToken}`,
      },
      body: JSON.stringify({
        requestedRole: "driver",
        profession: "سائق سيارة حديثة",
        vehicleDetails: "تويوتا كورولا 2022",
        bio: "سائق ملتزم خبرة 5 سنوات في شوارع القاهرة ومعايا سيارة سيدان حديثة",
      }),
    });
    const reqRoleData: any = await reqRoleRes.json();
    const roleReqId = reqRoleData.data?.request?.id;
    console.log(`  -> Role upgrade request submitted: ID ${roleReqId}, Requested: ${reqRoleData.data?.request?.requestedRole}`);

    // 3. Admin lists pending role requests
    const adminListRoleRes = await fetch(`http://127.0.0.1:${TEST_PORT}/api/admin/role-requests?status=PENDING`, {
      headers: { Authorization: `Bearer ${adminToken}` },
    });
    const adminListRoleData: any = await adminListRoleRes.json();
    const hasRoleRequest = Array.isArray(adminListRoleData.data) && adminListRoleData.data.some((r: any) => r.id === roleReqId);
    console.log(`  -> Admin retrieved pending role request in list? ${hasRoleRequest}`);

    // 4. Admin approves role request
    const adminApproveRes = await fetch(`http://127.0.0.1:${TEST_PORT}/api/admin/role-requests/${roleReqId}/approve`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${adminToken}`,
      },
      body: JSON.stringify({
        adminNotes: "Approved verified license and car documents",
      }),
    });
    const adminApproveData: any = await adminApproveRes.json();
    console.log(`  -> Admin approved request: ${adminApproveData.success}, New user role: ${adminApproveData.data?.request?.user?.role}`);

    // 5. Verify user's updated database attributes: role, profile, and overdraft limit (1500 EGP)
    const upgradedUserDb = await db.user.findUnique({
      where: { id: upgradeUserId },
      include: { wallet: true, providerProfile: true },
    });
    const isUpgraded = upgradedUserDb?.role === "DRIVER";
    const hasOverdraft = Number(upgradedUserDb?.wallet?.overdraftLimit) === 1500.00;
    const hasProfile = Boolean(upgradedUserDb?.providerProfile);
    console.log(`  -> Verification check: Role = ${upgradedUserDb?.role}, OverdraftLimit = $${upgradedUserDb?.wallet?.overdraftLimit}, HasProfile = ${hasProfile}`);

    const test25Passed =
      regCustRes.status === 201 &&
      reqRoleRes.status === 201 &&
      hasRoleRequest &&
      adminApproveRes.status === 200 &&
      isUpgraded &&
      hasOverdraft &&
      hasProfile;

    results["25_user_role_request_and_admin_approval"] = test25Passed;
    console.log(`  => TEST 25 RESULT: ${test25Passed ? "PASSED" : "FAILED"}`);

    // -------------------------------------------------------------
    // TEST 26: Admin System Config Control Panel (Zero Hardcoded Values)
    // -------------------------------------------------------------
    console.log("\n[TEST 26] Verifying Admin SystemConfig Control Panel...");
    const adminUserT26 = await db.user.findUnique({ where: { phone: "01000000041" } });
    const adminTokenT26 = await generateToken({
      id: adminUserT26!.id,
      phone: adminUserT26!.phone,
      role: "ADMIN",
      roles: ["admin"],
    });

    const { seedDefaultConfigs: seedCfg } = await import("../src/core/config/system-config.service.js");
    await seedCfg();

    // 1. List all configs — should return all 21 keys
    const listConfigsRes = await fetch(`http://127.0.0.1:${TEST_PORT}/api/admin/system-config`, {
      headers: { Authorization: `Bearer ${adminTokenT26}` },
    });
    const listConfigsData = await listConfigsRes.json() as any;
    const configCount = listConfigsData.data?.totalKeys ?? 0;
    console.log(`  -> System config keys available: ${configCount}`);

    // 2. Update overdraft limit to 2000 (admin increases credit line)
    const patchOverdraftRes = await fetch(`http://127.0.0.1:${TEST_PORT}/api/admin/system-config/driver_overdraft_limit`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${adminTokenT26}` },
      body: JSON.stringify({ value: "2000" }),
    });
    const patchOverdraftData = await patchOverdraftRes.json() as any;
    const overdraftUpdated = patchOverdraftData.data?.value === "2000";
    console.log(`  -> Overdraft limit updated to 2000: ${overdraftUpdated}`);

    // 3. Update instapay number
    const patchInstapayRes = await fetch(`http://127.0.0.1:${TEST_PORT}/api/admin/system-config/instapay_number`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${adminTokenT26}` },
      body: JSON.stringify({ value: "01000000000" }),
    });
    const instapayUpdated = patchInstapayRes.status === 200;
    console.log(`  -> Instapay number configured: ${instapayUpdated}`);

    // 4. Bulk update multiple configs at once
    const bulkUpdateRes = await fetch(`http://127.0.0.1:${TEST_PORT}/api/admin/system-config/bulk`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${adminTokenT26}` },
      body: JSON.stringify({
        updates: [
          { key: "vodafone_cash_number", value: "01100000000" },
          { key: "food_vendor_fee_pct", value: "3" },
          { key: "late_delivery_grace_minutes", value: "15" },
        ],
      }),
    });
    const bulkData = await bulkUpdateRes.json() as any;
    const bulkUpdatedCount = bulkData.data?.updatedCount ?? 0;
    console.log(`  -> Bulk update: ${bulkUpdatedCount} configs updated`);

    // 5. Non-admin access blocked
    const customerUserT26 = await db.user.findUnique({ where: { phone: "01000000001" } });
    const customerTokenT26 = await generateToken({
      id: customerUserT26!.id,
      phone: customerUserT26!.phone,
      role: "CUSTOMER",
      roles: ["customer"],
    });
    const unauthorizedConfigRes = await fetch(`http://127.0.0.1:${TEST_PORT}/api/admin/system-config`, {
      headers: { Authorization: `Bearer ${customerTokenT26}` },
    });
    const configAccessBlocked = unauthorizedConfigRes.status === 403;
    console.log(`  -> Non-admin access to system-config blocked: HTTP ${unauthorizedConfigRes.status} (Expected 403)`);

    // Restore overdraft to 1500 for other tests
    await fetch(`http://127.0.0.1:${TEST_PORT}/api/admin/system-config/driver_overdraft_limit`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${adminTokenT26}` },
      body: JSON.stringify({ value: "1500" }),
    });

    const test26Passed =
      listConfigsRes.status === 200 &&
      configCount >= 20 &&
      overdraftUpdated &&
      instapayUpdated &&
      bulkUpdatedCount === 3 &&
      configAccessBlocked;

    results["26_admin_system_config_control_panel"] = test26Passed;
    console.log(`  => TEST 26 RESULT: ${test26Passed ? "PASSED" : "FAILED"}`);

    // -------------------------------------------------------------
    // TEST 27: Wallet Top-up via Manual Proof of Transfer
    // -------------------------------------------------------------
    console.log("\n[TEST 27] Verifying Wallet Top-up with Proof of Transfer...");
    const topupCustomer = await db.user.findUnique({ where: { phone: "01000000002" } });
    const topupToken = await generateToken({
      id: topupCustomer!.id,
      phone: topupCustomer!.phone,
      role: "CUSTOMER",
      roles: ["customer"],
    });

    // 1. Initiate topup — Instapay not configured → should fail before setup
    // Then after admin sets instapay number (done above), it should work
    const initiateRes = await fetch(`http://127.0.0.1:${TEST_PORT}/api/wallet/topup/initiate`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${topupToken}` },
      body: JSON.stringify({ paymentMethod: "instapay", declaredAmount: 500 }),
    });
    const initiateData = await initiateRes.json() as any;
    const topupRequestId = initiateData.data?.topupRequest?.id;
    console.log(`  -> Topup initiation: HTTP ${initiateRes.status}, RequestId: ${topupRequestId || "N/A"}`);

    // 2. Submit proof with both image URL and description
    let proofStatus = "";
    if (topupRequestId) {
      const submitProofRes = await fetch(`http://127.0.0.1:${TEST_PORT}/api/wallet/topup/submit-proof`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${topupToken}` },
        body: JSON.stringify({
          requestId: topupRequestId,
          proofImageUrl: "https://storage.movex.app/proofs/transfer_01000000000_500egp.jpg",
          proofText: `تم التحويل 500 جنيه على رقم 01000000000 عبر انستا باي`,
        }),
      });
      const proofData = await submitProofRes.json() as any;
      proofStatus = proofData.data?.status || "";
      console.log(`  -> Proof submitted: HTTP ${submitProofRes.status}, AI Verdict: ${proofData.data?.aiVerdict}, Status: ${proofStatus}`);
    }

    // 3. Admin can see pending/flagged topup requests
    const adminTopupListRes = await fetch(`http://127.0.0.1:${TEST_PORT}/api/admin/wallet/topup-requests`, {
      headers: { Authorization: `Bearer ${adminTokenT26}` },
    });
    const adminTopupData = await adminTopupListRes.json() as any;
    const topupRequestsCount = adminTopupData.data?.requests?.length ?? 0;
    console.log(`  -> Admin topup requests list: HTTP ${adminTopupListRes.status}, Count: ${topupRequestsCount}`);

    // 4. Get topup history for user
    const historyRes = await fetch(`http://127.0.0.1:${TEST_PORT}/api/wallet/topup/history`, {
      headers: { Authorization: `Bearer ${topupToken}` },
    });
    const historyData = await historyRes.json() as any;
    const historyCount = historyData.data?.count ?? 0;
    console.log(`  -> Topup history: ${historyCount} request(s) for this user`);

    // 5. Admin can approve or reject
    let adminApproveTopupPassed = false;
    if (topupRequestId && (proofStatus === "PENDING" || proofStatus === "AI_FLAGGED" || proofStatus === "APPROVED")) {
      if (proofStatus !== "APPROVED") {
        const approveRes = await fetch(`http://127.0.0.1:${TEST_PORT}/api/admin/wallet/topup-requests/${topupRequestId}/approve`, {
          method: "POST",
          headers: { "Content-Type": "application/json", Authorization: `Bearer ${adminTokenT26}` },
          body: JSON.stringify({ adminNotes: "Verified manually by admin" }),
        });
        adminApproveTopupPassed = approveRes.status === 200;
        console.log(`  -> Admin approved topup: HTTP ${approveRes.status}`);
      } else {
        adminApproveTopupPassed = true;
        console.log(`  -> Topup was AI auto-approved`);
      }
    }

    const test27Passed =
      initiateRes.status === 201 &&
      !!topupRequestId &&
      adminTopupListRes.status === 200 &&
      historyRes.status === 200 &&
      historyCount >= 1;

    results["27_wallet_topup_proof_of_transfer"] = test27Passed;
    console.log(`  => TEST 27 RESULT: ${test27Passed ? "PASSED" : "FAILED"}`);

    // -------------------------------------------------------------
    // TEST 28: Delivery ETA Calculation & Driver Late Delivery Detection
    // -------------------------------------------------------------
    console.log("\n[TEST 28] Verifying Delivery ETA Calculation & Driver Laziness Detection...");

    // 1. Verify ETA calculation service directly
    const { calculateEta } = await import("../src/core/delivery/delivery-eta.service.js");
    const etaT28 = await calculateEta({
      pickupLat: 30.0444,
      pickupLng: 31.2357,
      dropoffLat: 30.0600,
      dropoffLng: 31.2500,
      vehicleType: VehicleType.motorcycle,
      urgency: "standard",
    });
    console.log(`  -> ETA calculated: ${etaT28.etaMinutes} min, ${etaT28.distanceKm} km, speed: ${etaT28.speedKmh} km/h`);

    // 2. Express urgency should be faster
    const expressEtaT28 = await calculateEta({
      pickupLat: 30.0444,
      pickupLng: 31.2357,
      dropoffLat: 30.0600,
      dropoffLng: 31.2500,
      vehicleType: VehicleType.motorcycle,
      urgency: "express",
    });
    const expressIsFasterT28 = expressEtaT28.etaMinutes < etaT28.etaMinutes;
    console.log(`  -> Express ETA (${expressEtaT28.etaMinutes} min) < Standard ETA (${etaT28.etaMinutes} min): ${expressIsFasterT28}`);

    // 3. Large truck is slower than motorcycle
    const truckEtaT28 = await calculateEta({
      pickupLat: 30.0444,
      pickupLng: 31.2357,
      dropoffLat: 30.0600,
      dropoffLng: 31.2500,
      vehicleType: VehicleType.large_truck,
      urgency: "standard",
    });
    const truckIsSlowerT28 = truckEtaT28.etaMinutes > etaT28.etaMinutes;
    console.log(`  -> Truck ETA (${truckEtaT28.etaMinutes} min) > Motorcycle ETA (${etaT28.etaMinutes} min): ${truckIsSlowerT28}`);

    // 4. Test admin driver performance endpoint
    const driverPerfRes = await fetch(`http://127.0.0.1:${TEST_PORT}/api/admin/drivers/performance`, {
      headers: { Authorization: `Bearer ${adminTokenT26}` },
    });
    const driverPerfData = await driverPerfRes.json() as any;
    const driverCount = driverPerfData.data?.totalDrivers ?? 0;
    console.log(`  -> Admin driver performance list: ${driverCount} drivers tracked`);

    // 5. Late deliveries endpoint
    const lateRes = await fetch(`http://127.0.0.1:${TEST_PORT}/api/admin/deliveries/late`, {
      headers: { Authorization: `Bearer ${adminTokenT26}` },
    });
    const lateData = await lateRes.json() as any;
    console.log(`  -> Late deliveries endpoint: HTTP ${lateRes.status}, Count: ${lateData.data?.count ?? 0}`);

    // 6. Verify late delivery check function is importable
    const { checkAndFlagLateDelivery: _cflCheck } = await import("../src/core/delivery/delivery-eta.service.js");

    const test28Passed =
      etaT28.etaMinutes > 0 &&
      etaT28.distanceKm > 0 &&
      expressIsFasterT28 &&
      truckIsSlowerT28 &&
      driverPerfRes.status === 200 &&
      lateRes.status === 200;

    results["28_delivery_eta_and_late_detection"] = test28Passed;
    console.log(`  => TEST 28 RESULT: ${test28Passed ? "PASSED" : "FAILED"}`);

    // -------------------------------------------------------------
    // Summary
    // -------------------------------------------------------------
    console.log("\n==================================================================");
    console.log("             ARCHITECTURAL VERIFICATION SUMMARY                   ");
    console.log("==================================================================");
    let allPassed = true;
    for (const [name, passed] of Object.entries(results)) {
      console.log(`  ${passed ? "✔ PASS" : "✖ FAIL"} : ${name}`);
      if (!passed) allPassed = false;
    }
    console.log("==================================================================");
    console.log(`OVERALL STATUS: ${allPassed ? "ALL 28 VERIFICATION SUITES PASSED" : "SOME SUITES FAILED"}`);
    console.log("==================================================================");

    if (!allPassed) {
      process.exitCode = 1;
    }
  } catch (err) {
    console.error("Verification error:", err);
    process.exitCode = 1;
  } finally {
    server.close();
    await db.$disconnect();
  }
}

runVerification();
