/**
 * SystemConfig Service
 * Replaces all hardcoded platform values with DB-driven, admin-configurable settings.
 * All keys are defined as typed constants below. Values are cached in-process with
 * a short TTL (60s) to avoid N+1 DB hits on every request.
 */

import { db } from "../../db.js";

// ---------------------------------------------------------------------------
// Config Key Constants
// ---------------------------------------------------------------------------
export const CONFIG_KEYS = {
  // Wallet / Finance
  DRIVER_OVERDRAFT_LIMIT: "driver_overdraft_limit",       // default: 1500
  WORKER_OVERDRAFT_LIMIT: "worker_overdraft_limit",       // default: 1500
  PLATFORM_CURRENCY: "platform_currency",                 // default: EGP

  // Commission Rates (stored in DB via CommissionRule — these are fallbacks)
  DEFAULT_COMMISSION_PCT: "default_commission_pct",       // default: 15
  FOOD_VENDOR_FEE_PCT: "food_vendor_fee_pct",            // default: 2
  FOOD_COURIER_FEE_PCT: "food_courier_fee_pct",          // default: 1

  // Topup / Payment
  INSTAPAY_NUMBER: "instapay_number",                     // platform Instapay account
  VODAFONE_CASH_NUMBER: "vodafone_cash_number",           // platform Vodafone Cash number
  BANK_TRANSFER_IBAN: "bank_transfer_iban",               // platform bank IBAN
  TOPUP_MIN_AMOUNT: "topup_min_amount",                  // default: 10
  TOPUP_MAX_AMOUNT: "topup_max_amount",                  // default: 50000
  TOPUP_AI_CONFIDENCE_THRESHOLD: "topup_ai_confidence_threshold", // default: 0.75

  // Delivery / ETA
  SPEED_WALKING_KMH: "speed_walking_kmh",                // default: 5
  SPEED_BICYCLE_KMH: "speed_bicycle_kmh",                // default: 15
  SPEED_MOTORCYCLE_KMH: "speed_motorcycle_kmh",          // default: 40
  SPEED_SEDAN_KMH: "speed_sedan_kmh",                    // default: 35
  SPEED_VAN_KMH: "speed_van_kmh",                        // default: 30
  SPEED_TRUCK_KMH: "speed_truck_kmh",                    // default: 25
  LATE_DELIVERY_GRACE_MINUTES: "late_delivery_grace_minutes", // default: 10
  ETA_BUFFER_MINUTES: "eta_buffer_minutes",              // default: 5

  // Defaults / Geo
  DEFAULT_LAT: "default_lat",                            // default: 30.0444 (Cairo)
  DEFAULT_LNG: "default_lng",                            // default: 31.2357 (Cairo)
} as const;

export type ConfigKey = typeof CONFIG_KEYS[keyof typeof CONFIG_KEYS];

// Default values used as fallback if key not in DB
const DEFAULTS: Record<ConfigKey, string> = {
  driver_overdraft_limit: "1500",
  worker_overdraft_limit: "1500",
  platform_currency: "EGP",
  default_commission_pct: "15",
  food_vendor_fee_pct: "2",
  food_courier_fee_pct: "1",
  instapay_number: "NOT_CONFIGURED",
  vodafone_cash_number: "NOT_CONFIGURED",
  bank_transfer_iban: "NOT_CONFIGURED",
  topup_min_amount: "10",
  topup_max_amount: "50000",
  topup_ai_confidence_threshold: "0.75",
  speed_walking_kmh: "5",
  speed_bicycle_kmh: "15",
  speed_motorcycle_kmh: "40",
  speed_sedan_kmh: "35",
  speed_van_kmh: "30",
  speed_truck_kmh: "25",
  late_delivery_grace_minutes: "10",
  eta_buffer_minutes: "5",
  default_lat: "30.0444",
  default_lng: "31.2357",
};

// ---------------------------------------------------------------------------
// In-memory cache with TTL
// ---------------------------------------------------------------------------
interface CacheEntry {
  value: string;
  expiresAt: number;
}

const CACHE_TTL_MS = 60_000; // 1 minute
const cache = new Map<string, CacheEntry>();

function cacheGet(key: string): string | null {
  const entry = cache.get(key);
  if (!entry) return null;
  if (Date.now() > entry.expiresAt) {
    cache.delete(key);
    return null;
  }
  return entry.value;
}

function cacheSet(key: string, value: string): void {
  cache.set(key, { value, expiresAt: Date.now() + CACHE_TTL_MS });
}

function cacheInvalidate(key?: string): void {
  if (key) {
    cache.delete(key);
  } else {
    cache.clear();
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Get a config value as a string. Falls back to DEFAULTS if not in DB.
 */
export async function getConfig(key: ConfigKey): Promise<string> {
  const cached = cacheGet(key);
  if (cached !== null) return cached;

  try {
    const row = await db.systemConfig.findUnique({ where: { key } });
    const value = row?.value ?? DEFAULTS[key] ?? "";
    cacheSet(key, value);
    return value;
  } catch {
    // If SystemConfig table doesn't exist yet (first boot), return default
    return DEFAULTS[key] ?? "";
  }
}

/**
 * Get config value as a number.
 */
export async function getConfigNumber(key: ConfigKey, fallback = 0): Promise<number> {
  const val = await getConfig(key);
  const parsed = parseFloat(val);
  return isNaN(parsed) ? fallback : parsed;
}

/**
 * Get multiple config values at once (single DB query).
 */
export async function getConfigs(keys: ConfigKey[]): Promise<Record<ConfigKey, string>> {
  const uncached: ConfigKey[] = [];
  const result: Partial<Record<ConfigKey, string>> = {};

  for (const key of keys) {
    const cached = cacheGet(key);
    if (cached !== null) {
      result[key] = cached;
    } else {
      uncached.push(key);
    }
  }

  if (uncached.length > 0) {
    try {
      const rows = await db.systemConfig.findMany({ where: { key: { in: uncached } } });
      const rowMap = new Map(rows.map((r) => [r.key, r.value]));
      for (const key of uncached) {
        const value = rowMap.get(key) ?? DEFAULTS[key] ?? "";
        result[key] = value;
        cacheSet(key, value);
      }
    } catch {
      for (const key of uncached) {
        result[key] = DEFAULTS[key] ?? "";
      }
    }
  }

  return result as Record<ConfigKey, string>;
}

/**
 * Set a config value. Admin only — invalidates cache.
 */
export async function setConfig(key: ConfigKey, value: string, updatedBy?: string): Promise<void> {
  await db.systemConfig.upsert({
    where: { key },
    update: { value, updatedBy },
    create: { key, value, updatedBy, description: `Platform config: ${key}` },
  });
  cacheInvalidate(key);
}

/**
 * List all config entries (for admin panel).
 */
export async function listAllConfigs() {
  const dbRows = await db.systemConfig.findMany({ orderBy: { key: "asc" } });
  const dbMap = new Map(dbRows.map((r) => [r.key, r]));

  // Merge with defaults so admin sees every key even if not in DB yet
  return Object.entries(DEFAULTS).map(([key, defaultValue]) => {
    const row = dbMap.get(key);
    return {
      key,
      value: row?.value ?? defaultValue,
      description: row?.description ?? null,
      isCustomized: !!row,
      updatedBy: row?.updatedBy ?? null,
      updatedAt: row?.updatedAt ?? null,
      defaultValue,
    };
  });
}

/**
 * Seed all default config values into the DB if they don't exist yet.
 * Called once during application startup.
 */
export async function seedDefaultConfigs(): Promise<void> {
  try {
    for (const [key, value] of Object.entries(DEFAULTS)) {
      await db.systemConfig.upsert({
        where: { key },
        update: {},  // Do NOT overwrite existing admin customizations
        create: { key, value, description: `Default platform config: ${key}` },
      });
    }
  } catch (err) {
    console.warn("[SystemConfig] Could not seed default configs:", err);
  }
}
