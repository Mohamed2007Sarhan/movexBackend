import { VehicleType } from "@prisma/client";
import { db } from "../../db.js";

export interface AiSuggestionRequest {
  userId: string;
  orderId?: string;
  context: {
    serviceType?: string;
    location?: { lat: number; lng: number };
    orderHistory?: any[];
    timeOfDay?: string;
    details?: string;
    text?: string;
    [key: string]: any;
  };
}

export interface AiSuggestionResponse {
  suggestion_type: "restaurant" | "provider" | "price_range" | "category";
  suggested_items: { id: string; reason: string }[];
  confidence: number;
}

const SYSTEM_PROMPT = `You are the MoveX AI Suggestion Engine.
Your job is to analyze user context across MoveX services (Food, Ride, Handyman, Moving) and produce intelligent recommendations.
You MUST output ONLY a valid JSON object matching this exact schema:
{
  "suggestion_type": "restaurant | provider | price_range | category",
  "suggested_items": [
    {
      "id": "string",
      "reason": "string"
    }
  ],
  "confidence": 0.0
}
Do NOT include any markdown code blocks, backticks, preamble, or explanations outside the JSON. Return raw JSON only.`;

export async function generateSuggestion(params: AiSuggestionRequest): Promise<AiSuggestionResponse> {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  let suggestion: AiSuggestionResponse;

  if (apiKey && apiKey.trim().length > 0 && !apiKey.includes("your-api-key")) {
    try {
      const response = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-api-key": apiKey,
          "anthropic-version": "2023-06-01",
        },
        body: JSON.stringify({
          model: "claude-sonnet-4-6",
          max_tokens: 1000,
          system: SYSTEM_PROMPT,
          messages: [
            {
              role: "user",
              content: `User Context:\n${JSON.stringify(params.context, null, 2)}`,
            },
          ],
        }),
      });

      if (!response.ok) {
        const errText = await response.text();
        throw new Error(`Anthropic API error (${response.status}): ${errText}`);
      }

      const data: any = await response.json();
      const rawText = data.content?.[0]?.text?.trim() || "{}";
      const cleanJson = rawText.replace(/^```json/m, "").replace(/^```/m, "").trim();
      suggestion = JSON.parse(cleanJson);
    } catch (err: any) {
      console.warn("[AI Service] Anthropic API call failed or timed out, using fallback inference:", err.message);
      suggestion = await fallbackInference(params.context);
    }
  } else {
    // Graceful offline heuristic inference when API key is not configured
    suggestion = await fallbackInference(params.context);
  }

  // Strictly Read-Only with respect to financial/order state: Log to AiSuggestionLog table
  try {
    await db.aiSuggestionLog.create({
      data: {
        userId: params.userId,
        orderId: params.orderId,
        inputContext: params.context as any,
        suggestion: suggestion as any,
      },
    });
  } catch (logErr: any) {
    console.error("[AI Service] Failed to log AI suggestion to DB:", logErr.message);
  }

  return suggestion;
}

async function fallbackInference(context: AiSuggestionRequest["context"]): Promise<AiSuggestionResponse> {
  const { serviceType, text, details } = context;

  // 1. Ambiguous category free-text -> query real categories from PostgreSQL
  if (text || (!serviceType && details)) {
    const query = (text || details || "").toLowerCase();
    
    // Query categories from database
    const allCategories = await db.serviceCategory.findMany();
    const findCat = (keyword: string) =>
      allCategories.find((c) => c.name.toLowerCase().includes(keyword.toLowerCase()))?.id;

    const catPlumb = findCat("plumb") || allCategories[0]?.id;
    if (query.includes("pipe") || query.includes("leak") || query.includes("water") || query.includes("sink")) {
      return {
        suggestion_type: "category",
        suggested_items: [{ id: catPlumb || "category_plumbing", reason: "Detected plumbing keywords matching active category in database" }],
        confidence: 0.94,
      };
    }
    if (query.includes("wire") || query.includes("light") || query.includes("electric") || query.includes("power")) {
      const catElectr = findCat("electr") || allCategories[0]?.id;
      return {
        suggestion_type: "category",
        suggested_items: [{ id: catElectr || "category_electrical", reason: "Detected electrical keywords matching active category in database" }],
        confidence: 0.92,
      };
    }
    if (query.includes("furniture") || query.includes("wood") || query.includes("door")) {
      const catCarpent = findCat("carpent") || allCategories[0]?.id;
      return {
        suggestion_type: "category",
        suggested_items: [{ id: catCarpent || "category_carpentry", reason: "Detected carpentry keywords matching active category in database" }],
        confidence: 0.91,
      };
    }
    if (query.includes("ride") || query.includes("car") || query.includes("drive")) {
      const catRide = findCat("ride") || allCategories[0]?.id;
      return {
        suggestion_type: "category",
        suggested_items: [{ id: catRide || "category_ride", reason: "Detected passenger transportation intent" }],
        confidence: 0.95,
      };
    }
    if (query.includes("move") || query.includes("truck") || query.includes("cargo")) {
      const catMov = findCat("mov") || allCategories[0]?.id;
      return {
        suggestion_type: "category",
        suggested_items: [{ id: catMov || "category_moving", reason: "Detected heavy cargo / relocation intent" }],
        confidence: 0.93,
      };
    }

    const defaultCat = allCategories[0]?.id || "category_general";
    return {
      suggestion_type: "category",
      suggested_items: [{ id: defaultCat, reason: "Default recommendation for generic consumer query" }],
      confidence: 0.75,
    };
  }

  // 2. Food suggestions -> query real open or catalog vendors from PostgreSQL
  if (serviceType === "food") {
    // 1st: Query open vendors
    let targetVendors = await db.vendor.findMany({
      where: { isOpen: true },
      include: { menuItems: { where: { isAvailable: true }, take: 1 } },
      take: 3,
    });

    // 2nd: If no open vendors, query all vendors in database
    if (targetVendors.length === 0) {
      targetVendors = await db.vendor.findMany({
        include: { menuItems: { take: 1 } },
        take: 3,
      });
    }

    if (targetVendors.length > 0) {
      return {
        suggestion_type: "restaurant",
        suggested_items: targetVendors.map((v) => ({
          id: v.id,
          reason: `Registered vendor ${v.name} at ${v.address} with active menu catalog`,
        })),
        confidence: 0.89,
      };
    }

    // 3rd: If no vendors, query real products from database catalog
    const realProducts = await db.product.findMany({ take: 3 });
    if (realProducts.length > 0) {
      return {
        suggestion_type: "restaurant",
        suggested_items: realProducts.map((p) => ({
          id: p.id,
          reason: `Catalog item ${p.name} available at $${p.price}`,
        })),
        confidence: 0.85,
      };
    }

    // 4th: Fallback to first available category from database
    const foodCat = (await db.serviceCategory.findFirst({ where: { name: { contains: "food", mode: "insensitive" } } })) || (await db.serviceCategory.findFirst());
    return {
      suggestion_type: "category",
      suggested_items: [{ id: foodCat?.id || "service_food", reason: "Food delivery category recommendation" }],
      confidence: 0.80,
    };
  }

  // 3. Price range for Ride / Handyman bidding -> query dynamic commission and rates from DB
  if (serviceType === "ride") {
    const rule = await db.commissionRule.findFirst({ where: { serviceType: "ride" } });
    const commPct = rule ? Number(rule.percentage) : 10;
    return {
      suggestion_type: "price_range",
      suggested_items: [
        { id: "floor_fare", reason: `Competitive opening price floor: $12.00 (Platform fee: ${commPct}%)` },
        { id: "clearing_fare", reason: `Optimal expected market clearing price: $16.50` },
        { id: "priority_fare", reason: `Priority rush ceiling: $22.00` },
      ],
      confidence: 0.88,
    };
  }

  if (serviceType === "handyman") {
    const rule = await db.commissionRule.findFirst({ where: { serviceType: "handyman" } });
    const commPct = rule ? Number(rule.percentage) : 10;
    return {
      suggestion_type: "price_range",
      suggested_items: [
        { id: "diagnostic_fare", reason: `Standard diagnostic visit: $25.00 (Platform fee: ${commPct}%)` },
        { id: "standard_fare", reason: `Average trade service rate with minor parts: $45.00` },
        { id: "complex_fare", reason: `Comprehensive repair ceiling: $75.00` },
      ],
      confidence: 0.86,
    };
  }

  // Default fallback
  const fallbackCat = await db.serviceCategory.findFirst();
  return {
    suggestion_type: "category",
    suggested_items: [{ id: fallbackCat?.id || "service_default", reason: "General platform recommendation" }],
    confidence: 0.70,
  };
}

export interface AiPriceMediationRequest {
  customerOffer: number;
  driverAsk: number;
  distanceKm?: number;
  pickupLat?: number;
  pickupLng?: number;
  dropoffLat?: number;
  dropoffLng?: number;
  serviceType?: string;
  notes?: string;
}

export interface AiPriceMediationResponse {
  mediatedPrice: number;
  customerOffer: number;
  driverAsk: number;
  distanceKm: number;
  estimatedDurationMins: number;
  customerSavings: number;
  driverSurplus: number;
  reasoning: string;
  reasoningAr: string;
}

/**
 * MoveX Fair Price AI Mediation Engine:
 * When Customer offers X and Driver asks Y, AI analyzes the route, distance,
 * traffic, and market benchmark to calculate a win-win compromise price.
 */
export async function mediateFairPrice(params: AiPriceMediationRequest): Promise<AiPriceMediationResponse> {
  const { customerOffer, driverAsk, pickupLat, pickupLng, dropoffLat, dropoffLng } = params;

  // 1. Calculate actual distance if coordinates available
  let distanceKm = params.distanceKm;
  if (!distanceKm && pickupLat && pickupLng && dropoffLat && dropoffLng) {
    const dLat = (dropoffLat - pickupLat) * (Math.PI / 180);
    const dLng = (dropoffLng - pickupLng) * (Math.PI / 180);
    const a =
      Math.sin(dLat / 2) ** 2 +
      Math.cos(pickupLat * (Math.PI / 180)) * Math.cos(dropoffLat * (Math.PI / 180)) * Math.sin(dLng / 2) ** 2;
    distanceKm = Math.round(6371 * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a)) * 100) / 100;
  }
  if (!distanceKm || distanceKm <= 0) {
    distanceKm = 4.5; // Average urban trip distance in km
  }

  const estimatedDurationMins = Math.max(5, Math.round(distanceKm * 2.2));

  // 2. Calculate fair objective benchmark: Base fare + distance cost
  const baseFare = 8.0;
  const perKmRate = 1.8;
  const benchmarkCost = Math.round((baseFare + distanceKm * perKmRate) * 100) / 100;

  // 3. AI Fair Compromise Formula:
  // Mediates a win-win midpoint between customerOffer and driverAsk, guided by benchmark
  const lower = Math.min(customerOffer, driverAsk);
  const higher = Math.max(customerOffer, driverAsk);

  let targetPrice = lower * 0.45 + higher * 0.55; // slightly favors driver to cover fuel & labor
  if (benchmarkCost > lower && benchmarkCost < higher) {
    // If benchmark lies between them, weight heavily towards the objective route cost
    targetPrice = benchmarkCost * 0.5 + targetPrice * 0.5;
  }

  // Strictly clamp between the two offers
  const mediatedPrice = Math.round(Math.min(higher - 0.5, Math.max(lower + 0.5, targetPrice)) * 10) / 10;
  const customerSavings = Math.round((higher - mediatedPrice) * 100) / 100;
  const driverSurplus = Math.round((mediatedPrice - lower) * 100) / 100;

  const reasoning = `Route analyzed: ${distanceKm} km (~${estimatedDurationMins} mins). MoveX AI mediated a win-win fair price of $${mediatedPrice.toFixed(2)} / EGP. Customer saves $${customerSavings.toFixed(2)} vs driver ask, and driver earns $${driverSurplus.toFixed(2)} above opening offer.`;
  const reasoningAr = `تم حساب المسافة الفعلية للطريق (${distanceKm} كم في حوالي ${estimatedDurationMins} دقيقة). وجد الذكاء الاصطناعي أن السعر العادل التوافقي هو ${mediatedPrice} جنيه، وهو ما يوفر للمستخدم ${customerSavings} جنيه، ويمنح السائق ${driverSurplus} جنيه زيادة عن العرض الأولي؛ وبذلك يرضى الطرفان.`;

  return {
    mediatedPrice,
    customerOffer: lower,
    driverAsk: higher,
    distanceKm,
    estimatedDurationMins,
    customerSavings,
    driverSurplus,
    reasoning,
    reasoningAr,
  };
}

export interface ParsedProviderProfile {
  profession: string;
  vehicleType: VehicleType | null;
  vehicleDetails: string;
  skills: string[];
}

/**
 * AI-driven provider registration analysis:
 * Parses free-form bio, vehicle notes, and trade descriptions into structured
 * VehicleType, profession classifications, and capability tags.
 */
export function parseProviderBio(input: string | {
  bio?: string;
  profession?: string;
  vehicleDetails?: string;
  vehicleType?: string;
}): ParsedProviderProfile {
  let text = "";
  let explicitVehicleType: string | undefined;
  let explicitProfession: string | undefined;
  let explicitVehicleDetails: string | undefined;

  if (typeof input === "string") {
    text = input.toLowerCase();
  } else if (input && typeof input === "object") {
    explicitVehicleType = input.vehicleType;
    explicitProfession = input.profession;
    explicitVehicleDetails = input.vehicleDetails;
    text = `${input.profession || ""} ${input.vehicleDetails || ""} ${input.bio || ""}`.toLowerCase();
  }

  // 1. Vehicle category detection
  let detectedVehicle: VehicleType | null = null;
  if (explicitVehicleType && Object.values(VehicleType).includes(explicitVehicleType as VehicleType)) {
    detectedVehicle = explicitVehicleType as VehicleType;
  } else if (/جامبو|تريلا|نقل ثقيل|شاحنة كبيرة|كونتينر|large.?truck|heavy/i.test(text)) {
    detectedVehicle = VehicleType.large_truck;
  } else if (/دبابة|نصف نقل|شاحنة صغيرة|small.?truck/i.test(text)) {
    detectedVehicle = VehicleType.small_truck;
  } else if (/فان|ميكروباص|ميني فان|van/i.test(text)) {
    detectedVehicle = VehicleType.van;
  } else if (/بيك اب|pickup/i.test(text)) {
    detectedVehicle = VehicleType.pickup;
  } else if (/موتوسيكل|سكوتر|دراجة نارية|motorcycle|scooter/i.test(text)) {
    detectedVehicle = VehicleType.motorcycle;
  } else if (/دراجة|عجلة|bicycle|bike/i.test(text)) {
    detectedVehicle = VehicleType.bicycle;
  } else if (/راجل|على رجلي|سير|مشاة|walking/i.test(text)) {
    detectedVehicle = VehicleType.walking;
  } else if (/عربية|سيارة|تاكسي|سيدان|sedan|car/i.test(text)) {
    detectedVehicle = VehicleType.sedan;
  }

  // 2. Profession detection
  let detectedProfession = explicitProfession || "";
  if (!detectedProfession) {
    if (/عفش|أثاث|موبيليا|نقل منزلي/i.test(text)) detectedProfession = "نقل أثاث وعفش";
    else if (/نجار|أبواب|شبابيك|خشب/i.test(text)) detectedProfession = "نجار موبيليا وباب وشباك";
    else if (/سباك|صحي|مواسير|صرف/i.test(text)) detectedProfession = "سباك فني صحي";
    else if (/كهرب|توصيلات|إنارة/i.test(text)) detectedProfession = "فني كهرباء منزلية";
    else if (/تكييف|تبريد/i.test(text)) detectedProfession = "فني تكييف وتبريد";
    else if (/دليفري|توصيل|أكل|طلبات/i.test(text)) detectedProfession = "كابتن توصيل دليفري";
    else if (detectedVehicle) detectedProfession = "سائق نقل وتوصيل";
    else detectedProfession = "مقدم خدمات عامة";
  }

  // 3. Skills extraction
  const skillKeywords = [
    { tag: "عفش", pattern: /عفش|أثاث|موبيليا/i },
    { tag: "فك وتركيب", pattern: /فك|تركيب/i },
    { tag: "نقل ثقيل", pattern: /نقل ثقيل|حمولة|جامبو|تريلا/i },
    { tag: "ونش", pattern: /ونش|رفع/i },
    { tag: "تغليف", pattern: /تغليف|كراتين/i },
    { tag: "أدوار علوية", pattern: /أدوار علوية|سلالم|طوابق/i },
    { tag: "سباكة", pattern: /سباك|مواسير|خلاطات/i },
    { tag: "نجارة", pattern: /نجار|أبواب|كالون/i },
    { tag: "كهرباء", pattern: /كهرباء|لوحات|أسلاك/i },
    { tag: "دليفري سريع", pattern: /سريع|دليفري|طعام|فوري/i },
  ];

  const extractedSkills = new Set<string>();
  for (const { tag, pattern } of skillKeywords) {
    if (pattern.test(text)) {
      extractedSkills.add(tag);
    }
  }

  return {
    profession: detectedProfession,
    vehicleType: detectedVehicle,
    vehicleDetails: explicitVehicleDetails || (detectedVehicle ? `مركبة ${detectedVehicle}` : "بدون مركبة"),
    skills: Array.from(extractedSkills),
  };
}

export interface MatchOptimalProvidersRequest {
  taskDescription: string;
  lat?: number;
  lng?: number;
  customerLat?: number;
  customerLng?: number;
  serviceType?: string;
  maxDistanceKm?: number;
}

export interface MatchOptimalProvidersResponse {
  taskInferred: {
    serviceType: string;
    vehicleType?: string;
    requiredVehicleCapacity: string;
    detectedKeywords: string[];
    skills?: string[];
  };
  inferredRequirements: {
    serviceType: string;
    vehicleType?: string;
    requiredVehicleCapacity: string;
    detectedKeywords: string[];
    skills?: string[];
  };
  recommendedProviders: {
    providerId: string;
    userId: string;
    name: string;
    phone: string;
    profession: string;
    vehicleType: string;
    vehicleDetails: string;
    skills: string[];
    distanceKm: number;
    matchScore: number;
    selectionReasonAr: string;
  }[];
  rankedProviders: {
    providerId: string;
    userId: string;
    name: string;
    phone: string;
    profession: string;
    vehicleType: string;
    vehicleDetails: string;
    skills: string[];
    distanceKm: number;
    matchScore: number;
    selectionReasonAr: string;
  }[];
}

/**
 * Dynamic Semantic Matching:
 * Customer types free text (e.g. "نقل عفش شقة محتاج عربية كبيرة لنقل العفش")
 * AI infers capacity needed (large truck vs sedan), queries DB providers matching skills,
 * checks proximity, and returns ranked best fits with full Arabic reasoning.
 */
export async function matchOptimalProviders(
  params: MatchOptimalProvidersRequest
): Promise<MatchOptimalProvidersResponse> {
  const taskDesc = params.taskDescription || "";
  const lat = params.lat ?? params.customerLat ?? 30.0444;
  const lng = params.lng ?? params.customerLng ?? 31.2357;
  const maxDistanceKm = params.maxDistanceKm ?? 35;
  const lowerDesc = taskDesc.toLowerCase();

  // 1. Analyze task requirements
  const isMovingFurniture = /عفش|أثاث|موبيليا|غرف.?نوم|سفرة|أجهزة.?ثقيلة|نقل.?شقة/i.test(lowerDesc);
  const isHandyman = /نجار|سباك|كهرب|تكييف|صيانة|إصلاح/i.test(lowerDesc);
  const isQuickDelivery = /دليفري|أكل|طعام|طرد|سريع|مستعجل/i.test(lowerDesc);

  let requiredVehicleCapacity = "any";
  let targetVehicleTypes: VehicleType[] = [];

  if (isMovingFurniture) {
    requiredVehicleCapacity = "heavy_capacity";
    targetVehicleTypes = [VehicleType.large_truck, VehicleType.small_truck, VehicleType.van];
  } else if (isQuickDelivery) {
    requiredVehicleCapacity = "quick_transport";
    targetVehicleTypes = [VehicleType.motorcycle, VehicleType.sedan, VehicleType.bicycle];
  }

  // 2. Query candidate providers from database
  let candidateProfiles = await db.providerProfile.findMany({
    where: {
      isAvailable: true,
      ...(targetVehicleTypes.length > 0 ? { vehicleType: { in: targetVehicleTypes } } : {}),
    },
    include: {
      user: { select: { id: true, name: true, phone: true } },
    },
  });

  if (!candidateProfiles.length && targetVehicleTypes.length === 0) {
    candidateProfiles = await db.providerProfile.findMany({
      where: { isAvailable: true },
      include: {
        user: { select: { id: true, name: true, phone: true } },
      },
    });
  }

  // 3. Semantic scoring and proximity ranking
  const scored = candidateProfiles.map((p) => {
    const pLat = p.currentLat ?? lat;
    const pLng = p.currentLng ?? lng;
    const dLat = (pLat - lat) * (Math.PI / 180);
    const dLng = (pLng - lng) * (Math.PI / 180);
    const a =
      Math.sin(dLat / 2) ** 2 +
      Math.cos(lat * (Math.PI / 180)) * Math.cos(pLat * (Math.PI / 180)) * Math.sin(dLng / 2) ** 2;
    const distanceKm = Math.round(6371 * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a)) * 100) / 100;

    // Check keyword overlap
    const providerText = `${p.profession || ""} ${p.bio || ""} ${p.vehicleDetails || ""} ${(p.skills || []).join(" ")}`.toLowerCase();
    let matchHits = 0;
    const keywords = ["عفش", "أثاث", "فك", "تركيب", "ونش", "نجار", "سباك", "كهرباء", "شاحنة", "دليفري", "جامبو"];
    for (const kw of keywords) {
      if (lowerDesc.includes(kw) && providerText.includes(kw)) {
        matchHits += 1;
      }
    }

    // Heavy truck bonus when moving furniture
    let vehicleBonus = 0;
    if (isMovingFurniture && p.vehicleType === VehicleType.large_truck) {
      vehicleBonus = 50;
    }

    const proximityScore = Math.max(0, 50 - distanceKm);
    const matchScore = matchHits * 25 + vehicleBonus + proximityScore;

    const selectionReasonAr = isMovingFurniture
      ? `تم ترشيح ${p.user.name} لأن لديه مركبة (${p.vehicleType || "شاحنة"}) مخصصة لنقل الأثاث والعفش ولديه خبرة مطابقة، ويبعد ${distanceKm} كم عن موقعك.`
      : `تم ترشيح ${p.user.name} لملائمة مهاراته (${p.profession || "مهني متخصص"}) وقربه لموقعك (${distanceKm} كم).`;

    return {
      providerId: p.id,
      userId: p.userId,
      name: p.user.name,
      phone: p.user.phone,
      profession: p.profession || "مقدم خدمة معتمد",
      vehicleType: String(p.vehicleType || "walking"),
      vehicleDetails: p.vehicleDetails || "مركبة معتمدة",
      skills: p.skills || [],
      distanceKm,
      matchScore,
      selectionReasonAr,
    };
  });

  scored.sort((a, b) => b.matchScore - a.matchScore);

  const inferredRequirements = {
    serviceType: isMovingFurniture ? "moving" : isHandyman ? "handyman" : "general",
    vehicleType: isMovingFurniture ? "large_truck" : (isQuickDelivery ? "motorcycle" : "sedan"),
    requiredVehicleCapacity,
    detectedKeywords: isMovingFurniture ? ["عفش", "نقل ثقيل", "فك وتركيب"] : ["خدمة متخصصة"],
    skills: isMovingFurniture ? ["عفش", "فك وتركيب", "نقل ثقيل"] : [],
  };

  const topResults = scored.slice(0, 5);

  return {
    taskInferred: inferredRequirements,
    inferredRequirements,
    recommendedProviders: topResults,
    rankedProviders: topResults,
  };
}
