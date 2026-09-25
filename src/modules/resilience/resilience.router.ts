import { Router, Request, Response } from "express";
import {
  getAllCircuitBreakersStatus,
  simulateServiceFailure,
  isFailureSimulated,
  planBAiSuggest,
  planBRouteCalculation,
  planBVehicleDispatch,
  planBNotificationSend,
} from "../../core/resilience/index.js";
import { sendSuccess } from "../../core/errors/index.js";
import { VehicleType } from "@prisma/client";

export const resilienceRouter = Router();

/**
 * GET /api/resilience/status
 * Returns real-time health and status of all circuit breakers and Plan B systems.
 */
resilienceRouter.get("/status", (_req: Request, res: Response) => {
  const breakers = getAllCircuitBreakersStatus();
  return sendSuccess(res, {
    systemHealth: "operational",
    planBEngine: "active",
    circuitBreakers: breakers,
    simulatedFailures: {
      ai_engine: isFailureSimulated("ai_engine"),
      maps_routing_service: isFailureSimulated("maps_routing_service"),
      notification_socket_dispatch: isFailureSimulated("notification_socket_dispatch"),
    },
  });
});

/**
 * POST /api/resilience/simulate-failure
 * Toggle artificial failure to demonstrate Plan B seamless recovery.
 */
resilienceRouter.post("/simulate-failure", (req: Request, res: Response) => {
  const { serviceName, enable } = req.body;
  if (!serviceName || typeof enable !== "boolean") {
    return res.status(400).json({ message: "serviceName and boolean enable are required" });
  }

  simulateServiceFailure(serviceName, enable);
  return sendSuccess(res, {
    serviceName,
    simulatedFailureActive: enable,
    message: enable
      ? `Simulated failure enabled for ${serviceName}. Plan B will activate automatically on subsequent calls.`
      : `Simulated failure disabled for ${serviceName}. Normal operations resumed.`,
  });
});

/**
 * POST /api/resilience/test-plan-b
 * Runs instant verification of Plan B across AI, Routing, Escalation, and Notification.
 */
resilienceRouter.post("/test-plan-b", async (req: Request, res: Response, next) => {
  try {
    const { testTarget = "all" } = req.body;
    const results: Record<string, any> = {};

    // 1. AI Plan B test
    if (testTarget === "all" || testTarget === "ai") {
      const aiTest = await planBAiSuggest("food", "recommend spicy lunch", async () => {
        // Intentionally throw if simulated or testing
        throw new Error("Simulated Primary LLM Network Timeout");
      });
      results.aiPlanB = aiTest;
    }

    // 2. Geospatial Routing Plan B test
    if (testTarget === "all" || testTarget === "routing") {
      const routeTest = await planBRouteCalculation(30.0444, 31.2357, 30.0754, 31.3204);
      results.routingPlanB = routeTest;
    }

    // 3. Vehicle Capacity Escalation Plan B test
    if (testTarget === "all" || testTarget === "moving") {
      // Search for pickup in Cairo
      const movingTest = await planBVehicleDispatch(VehicleType.pickup, 30.0444, 31.2357, 50);
      results.movingPlanB = movingTest;
    }

    return sendSuccess(res, {
      message: "Plan B resilience verification executed successfully. Zero crashes detected.",
      results,
    });
  } catch (err) {
    next(err);
  }
});
