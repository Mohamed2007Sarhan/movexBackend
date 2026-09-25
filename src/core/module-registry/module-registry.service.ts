import { ServiceType } from "@prisma/client";

export interface ModuleDefinition {
  key: ServiceType;
  displayName: string;
  usesBidding: boolean;
  requiresVehicleEnforcement: boolean;
  description: string;
}

/**
 * MoveX Module Registry
 * Architectural Decision:
 * Implemented as a strongly typed, static in-code registry with runtime query and registration APIs.
 * This guarantees zero DB startup latency, full compile-time type safety across all service modules,
 * and programmatic introspection for order-engine and dispatch layers.
 */
export const MODULE_REGISTRY: Record<ServiceType, ModuleDefinition> = {
  [ServiceType.food]: {
    key: ServiceType.food,
    displayName: "MoveX Food & Grocery",
    usesBidding: false,
    requiresVehicleEnforcement: false,
    description: "Fixed-price restaurant and grocery ordering with immediate courier matching",
  },
  [ServiceType.ride]: {
    key: ServiceType.ride,
    displayName: "MoveX Ride",
    usesBidding: true,
    requiresVehicleEnforcement: false,
    description: "On-demand passenger transportation with realtime driver bidding",
  },
  [ServiceType.handyman]: {
    key: ServiceType.handyman,
    displayName: "MoveX Handyman & Home Services",
    usesBidding: true,
    requiresVehicleEnforcement: false,
    description: "Home maintenance and trade services (plumbing, electrical, carpentry) with worker bidding",
  },
  [ServiceType.moving]: {
    key: ServiceType.moving,
    displayName: "MoveX Logistics & Moving",
    usesBidding: false,
    requiresVehicleEnforcement: true,
    description: "Equipment, freight, and home relocation with strict vehicle capacity hierarchy enforcement",
  },
};

export function getModule(key: ServiceType): ModuleDefinition | undefined {
  return MODULE_REGISTRY[key];
}

export function getAllModules(): ModuleDefinition[] {
  return Object.values(MODULE_REGISTRY);
}

export function moduleUsesBidding(key: ServiceType): boolean {
  return MODULE_REGISTRY[key]?.usesBidding ?? false;
}

export function moduleRequiresVehicleEnforcement(key: ServiceType): boolean {
  return MODULE_REGISTRY[key]?.requiresVehicleEnforcement ?? false;
}
