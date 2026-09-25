/**
 * MoveX Plan B Resilience Engine
 * 
 * Provides circuit breaking, automated fallbacks, and fault tolerance
 * across all critical subsystems to ensure zero downtime.
 */

export interface CircuitBreakerOptions {
  failureThreshold?: number;     // Number of failures before opening circuit (default: 3)
  recoveryTimeoutMs?: number;    // Time to wait before testing primary again (default: 10,000ms)
  timeoutMs?: number;            // Request timeout before treating as failure (default: 5,000ms)
}

export type CircuitState = "CLOSED" | "OPEN" | "HALF_OPEN";

export class CircuitBreaker {
  public state: CircuitState = "CLOSED";
  public failureCount: number = 0;
  public successCount: number = 0;
  public lastFailureTime: number = 0;
  public totalExecutions: number = 0;
  public fallbackCount: number = 0;

  constructor(
    public readonly name: string,
    public readonly options: CircuitBreakerOptions = {}
  ) {
    this.options.failureThreshold = options.failureThreshold ?? 3;
    this.options.recoveryTimeoutMs = options.recoveryTimeoutMs ?? 10000;
    this.options.timeoutMs = options.timeoutMs ?? 5000;
  }

  public isOpen(): boolean {
    if (this.state === "OPEN") {
      const now = Date.now();
      if (now - this.lastFailureTime > (this.options.recoveryTimeoutMs || 10000)) {
        this.state = "HALF_OPEN";
        return false;
      }
      return true;
    }
    return false;
  }

  public recordSuccess(): void {
    this.failureCount = 0;
    this.successCount++;
    this.state = "CLOSED";
  }

  public recordFailure(): void {
    this.failureCount++;
    this.lastFailureTime = Date.now();
    if (this.failureCount >= (this.options.failureThreshold || 3)) {
      this.state = "OPEN";
    }
  }

  public recordFallback(): void {
    this.fallbackCount++;
  }
}

// Registry of circuit breakers by service name
const circuitBreakers = new Map<string, CircuitBreaker>();

export function getOrCreateCircuitBreaker(name: string, options?: CircuitBreakerOptions): CircuitBreaker {
  let cb = circuitBreakers.get(name);
  if (!cb) {
    cb = new CircuitBreaker(name, options);
    circuitBreakers.set(name, cb);
  }
  return cb;
}

export function getAllCircuitBreakersStatus() {
  const result: Record<string, any> = {};
  for (const [name, cb] of circuitBreakers.entries()) {
    result[name] = {
      state: cb.state,
      failureCount: cb.failureCount,
      successCount: cb.successCount,
      totalExecutions: cb.totalExecutions,
      fallbackCount: cb.fallbackCount,
      lastFailureTime: cb.lastFailureTime ? new Date(cb.lastFailureTime).toISOString() : null,
    };
  }
  return result;
}

// Global simulation flag for testing
let simulatedFailures = new Set<string>();

export function simulateServiceFailure(serviceName: string, enable: boolean) {
  if (enable) {
    simulatedFailures.add(serviceName);
  } else {
    simulatedFailures.delete(serviceName);
  }
}

export function isFailureSimulated(serviceName: string): boolean {
  return simulatedFailures.has(serviceName);
}

/**
 * Universal Plan B Execution Wrapper
 * Wraps any asynchronous operation with timeout, circuit breaking,
 * and seamless fallback execution.
 */
export async function executeWithPlanB<T>(
  serviceName: string,
  primaryFn: () => Promise<T>,
  fallbackFn: (err: Error) => Promise<T> | T,
  options?: CircuitBreakerOptions
): Promise<{ data: T; fallbackTriggered: boolean; latencyMs: number; error?: string }> {
  const startTime = Date.now();
  const cb = getOrCreateCircuitBreaker(serviceName, options);
  cb.totalExecutions++;

  // Check if failure is simulated for this service or circuit is already OPEN
  if (isFailureSimulated(serviceName) || cb.isOpen()) {
    cb.recordFallback();
    const reason = isFailureSimulated(serviceName)
      ? `Simulated failure active for service: ${serviceName}`
      : `Circuit breaker OPEN for service: ${serviceName}`;
    console.warn(`[Plan B ACTIVATED] [${serviceName}] ${reason} -> invoking fallback.`);
    const fallbackData = await fallbackFn(new Error(reason));
    return {
      data: fallbackData,
      fallbackTriggered: true,
      latencyMs: Date.now() - startTime,
      error: reason,
    };
  }

  // Attempt primary function with timeout
  try {
    const timeoutMs = options?.timeoutMs || 5000;
    const timeoutPromise = new Promise<never>((_, reject) => {
      setTimeout(() => reject(new Error(`Timeout after ${timeoutMs}ms on service ${serviceName}`)), timeoutMs);
    });

    const primaryData = await Promise.race([primaryFn(), timeoutPromise]);
    cb.recordSuccess();
    return {
      data: primaryData,
      fallbackTriggered: false,
      latencyMs: Date.now() - startTime,
    };
  } catch (err: any) {
    cb.recordFailure();
    cb.recordFallback();
    console.warn(`[Plan B ACTIVATED] [${serviceName}] Primary failed: ${err.message}. Invoking fallback.`);
    const fallbackData = await fallbackFn(err);
    return {
      data: fallbackData,
      fallbackTriggered: true,
      latencyMs: Date.now() - startTime,
      error: err.message,
    };
  }
}
