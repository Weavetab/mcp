import { logDebug } from "../audit/logger.js";
/**
 * Weavetab — sensors/operation_monitor.ts
 * Intelligent operation monitoring for detecting and resolving tool execution lag.
 * Detects when operations hang inside tool execution and provides adaptive bail-out.
 * Weavetab by fy2ne
 */

export interface OperationPhase {
  name: string;
  startTime: number;
  endTime?: number;
  duration?: number;
  completed: boolean;
  warning?: string;
}

export interface OperationDiagnostics {
  toolName: string;
  totalDuration: number;
  phases: OperationPhase[];
  bottlenecks: string[];
  health: "healthy" | "degraded" | "critical";
  bailOutReason?: string;
}

class OperationMonitor {
  private activeOperations: Map<string, {
    toolName: string;
    startTime: number;
    phases: OperationPhase[];
    diagnosticsTimer?: ReturnType<typeof setInterval>;
  }> = new Map();
  
  private readonly PHASE_THRESHOLDS = {
    // Expected maximum duration for each phase (in ms)
    setup: 500,            // Security checks, session setup
    element_resolution: 1000,  // Finding elements in DOM
    actionability_check: 800,  // Checking if element is clickable
    ghost_move: 500,      // Ghost cursor movement
    action_dispatch: 300,  // Actual click/type dispatch
    stuck_check: 1000,     // Post-action stuck detection
    network_wait: 3000,    // Network idle waiting
    dom_stability: 1500,   // DOM stability checks
  };
  
  private readonly BAIL_OUT_THRESHOLDS = {
    // When to bail out with degraded results (in ms)
    element_resolution: 2500,
    actionability_check: 2000,
    network_wait: 6000,
    dom_stability: 4000,
  };
  
  private readonly TOTAL_OPERATION_TIMEOUT = 15000; // 15s max for any operation
  
  /**
   * Start monitoring a new tool operation
   */
  startOperation(operationId: string, toolName: string): void {
    this.activeOperations.set(operationId, {
      toolName,
      startTime: Date.now(),
      phases: [],
    });
    
    // Start periodic health check
    const diagnosticsTimer = setInterval(() => {
      this.checkOperationHealth(operationId);
    }, 1000); // Check every 1 second (reduced from 2s for faster detection)
    
    this.activeOperations.get(operationId)!.diagnosticsTimer = diagnosticsTimer;
  }
  
  /**
   * Record the start of a specific phase within an operation
   */
  startPhase(operationId: string, phaseName: string): void {
    const op = this.activeOperations.get(operationId);
    if (!op) return;
    
    op.phases.push({
      name: phaseName,
      startTime: Date.now(),
      completed: false,
    });
  }
  
  /**
   * Record the completion of a specific phase
   */
  endPhase(operationId: string, phaseName: string, warning?: string): void {
    const op = this.activeOperations.get(operationId);
    if (!op) return;
    
    const phase = op.phases.find(p => p.name === phaseName && !p.completed);
    if (phase) {
      phase.endTime = Date.now();
      phase.duration = phase.endTime - phase.startTime;
      phase.completed = true;
      phase.warning = warning;
    }
  }
  
  /**
   * End operation monitoring and return diagnostics
   */
  endOperation(operationId: string): OperationDiagnostics | null {
    const op = this.activeOperations.get(operationId);
    if (!op) return null;
    
    // Clear diagnostics timer
    if (op.diagnosticsTimer) {
      clearInterval(op.diagnosticsTimer);
    }
    
    const totalDuration = Date.now() - op.startTime;
    const bottlenecks = this.identifyBottlenecks(op.phases);
    const health = this.determineHealth(totalDuration, bottlenecks);
    
    const diagnostics: OperationDiagnostics = {
      toolName: op.toolName,
      totalDuration,
      phases: op.phases,
      bottlenecks,
      health,
    };
    
    this.activeOperations.delete(operationId);
    return diagnostics;
  }
  
  /**
   * Check if an operation should bail out with degraded results
   */
  shouldBailOut(operationId: string): { shouldBail: boolean; reason?: string } {
    const op = this.activeOperations.get(operationId);
    if (!op) return { shouldBail: false };
    
    const totalDuration = Date.now() - op.startTime;
    
    // Check total operation timeout
    if (totalDuration > this.TOTAL_OPERATION_TIMEOUT) {
      return { shouldBail: true, reason: `Total operation timeout (${totalDuration}ms > ${this.TOTAL_OPERATION_TIMEOUT}ms)` };
    }
    
    // Check specific phase timeouts
    const currentPhase = op.phases.find(p => !p.completed);
    if (currentPhase) {
      const phaseDuration = Date.now() - currentPhase.startTime;
      const bailOutThreshold = this.BAIL_OUT_THRESHOLDS[currentPhase.name as keyof typeof this.BAIL_OUT_THRESHOLDS];
      
      if (bailOutThreshold && phaseDuration > bailOutThreshold) {
        return { 
          shouldBail: true, 
          reason: `Phase '${currentPhase.name}' timeout (${phaseDuration}ms > ${bailOutThreshold}ms)` 
        };
      }
    }
    
    return { shouldBail: false };
  }
  
  /**
   * Get current operation status for diagnostics
   */
  getOperationStatus(operationId: string): {
    toolName: string;
    duration: number;
    currentPhase: string;
    health: "healthy" | "degraded" | "critical";
  } | null {
    const op = this.activeOperations.get(operationId);
    if (!op) return null;
    
    const duration = Date.now() - op.startTime;
    const currentPhase = op.phases.find(p => !p.completed)?.name || "idle";
    const health = this.determineHealth(duration, []);
    
    return {
      toolName: op.toolName,
      duration,
      currentPhase,
      health,
    };
  }
  
  /**
   * Periodic health check for active operations
   */
  private checkOperationHealth(operationId: string): void {
    const op = this.activeOperations.get(operationId);
    if (!op) return;
    
    const duration = Date.now() - op.startTime;
    const currentPhase = op.phases.find(p => !p.completed);
    
    if (currentPhase) {
      const phaseDuration = Date.now() - currentPhase.startTime;
      const threshold = this.PHASE_THRESHOLDS[currentPhase.name as keyof typeof this.PHASE_THRESHOLDS];
      
      if (threshold && phaseDuration > threshold) {
        // Phase is taking longer than expected
        logDebug(`[Weavetab Monitor] Phase '${currentPhase.name}' taking longer than expected: ${phaseDuration}ms (threshold: ${threshold}ms)`);
        
        // Add warning to phase
        currentPhase.warning = `Exceeded threshold by ${phaseDuration - threshold}ms`;
      }
    }
    
    if (duration > this.TOTAL_OPERATION_TIMEOUT * 0.7) {
      // Operation is approaching timeout
      logDebug(`[Weavetab Monitor] Operation '${op.toolName}' approaching timeout: ${duration}ms / ${this.TOTAL_OPERATION_TIMEOUT}ms`);
    }
  }
  
  /**
   * Identify bottlenecks in operation phases
   */
  private identifyBottlenecks(phases: OperationPhase[]): string[] {
    const bottlenecks: string[] = [];
    
    for (const phase of phases) {
      if (!phase.completed || !phase.duration) continue;
      
      const threshold = this.PHASE_THRESHOLDS[phase.name as keyof typeof this.PHASE_THRESHOLDS];
      if (threshold && phase.duration > threshold) {
        bottlenecks.push(`${phase.name}: ${phase.duration}ms (threshold: ${threshold}ms)`);
      }
    }
    
    return bottlenecks;
  }
  
  /**
   * Determine overall operation health
   */
  private determineHealth(duration: number, bottlenecks: string[]): "healthy" | "degraded" | "critical" {
    if (bottlenecks.length > 2 || duration > this.TOTAL_OPERATION_TIMEOUT * 0.8) {
      return "critical";
    }
    if (bottlenecks.length > 0 || duration > this.TOTAL_OPERATION_TIMEOUT * 0.5) {
      return "degraded";
    }
    return "healthy";
  }
  /**
   * Clear every active diagnostics timer. Registered on process exit events so
   * that a tool crashing before endOperation() can't leave an interval firing
   * every second and pinning the Node.js event loop.
   */
  cleanupAll(): void {
    for (const [id, op] of this.activeOperations.entries()) {
      if (op.diagnosticsTimer) {
        clearInterval(op.diagnosticsTimer);
      }
      this.activeOperations.delete(id);
    }
  }
}

export const operationMonitor = new OperationMonitor();

// Register shutdown hooks so timers are always cleared, even on crashes
process.on('exit', () => operationMonitor.cleanupAll());
process.on('SIGINT', () => { operationMonitor.cleanupAll(); });
process.on('SIGTERM', () => { operationMonitor.cleanupAll(); });
process.on('uncaughtException', () => { operationMonitor.cleanupAll(); });