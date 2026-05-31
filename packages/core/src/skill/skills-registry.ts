export interface SkillDefinition {
  name: string;
  description: string;
  parametersSchema?: any;
}

export class SkillCircuitBreakerError extends Error {
  override readonly name = "SkillCircuitBreakerError";
  constructor(public readonly skillName: string, message: string) {
    super(message);
  }
}

export class SkillsRegistry {
  private static instance: SkillsRegistry;
  private skills: Map<string, SkillDefinition> = new Map();
  private failureCounts: Map<string, number> = new Map();
  private trippedAtTimestamps: Map<string, number> = new Map();
  private readonly FAILURE_LIMIT = 3;
  private readonly COOLDOWN_MS = 300_000; // 5 minutes

  private constructor() {}

  public static getInstance(): SkillsRegistry {
    if (!SkillsRegistry.instance) {
      SkillsRegistry.instance = new SkillsRegistry();
    }
    return SkillsRegistry.instance;
  }

  public registerSkill(skill: SkillDefinition): void {
    this.skills.set(skill.name, skill);
  }

  public getSkill(name: string): SkillDefinition | null {
    return this.skills.get(name) ?? null;
  }

  public listSkills(): SkillDefinition[] {
    return Array.from(this.skills.values());
  }

  /**
   * Checks if a skill's circuit breaker is currently tripped.
   * Auto-resets the skill if the 5-minute cooldown period has passed.
   */
  public isSkillTripped(name: string): boolean {
    const trippedAt = this.trippedAtTimestamps.get(name);
    if (trippedAt !== undefined) {
      if (Date.now() - trippedAt > this.COOLDOWN_MS) {
        this.resetSkill(name);
        return false;
      }
      return true;
    }
    return false;
  }

  /**
   * Resets the failure counter and circuit breaker for a skill.
   */
  public resetSkill(name: string): void {
    this.failureCounts.delete(name);
    this.trippedAtTimestamps.delete(name);
  }

  /**
   * Records a successful execution of a skill, resetting its failure counter.
   */
  public recordSuccess(name: string): void {
    this.failureCounts.delete(name);
    this.trippedAtTimestamps.delete(name);
  }

  /**
   * Records a failure for a skill. Trips the circuit breaker if the failure count reaches the limit.
   */
  public recordFailure(name: string): void {
    const current = (this.failureCounts.get(name) ?? 0) + 1;
    this.failureCounts.set(name, current);

    if (current >= this.FAILURE_LIMIT) {
      this.trippedAtTimestamps.set(name, Date.now());
    }
  }

  /**
   * Executes a skill's callback function, wrapping it in circuit-breaker logic.
   * Trips ONLY on tool execution exceptions/crashes, not quality gate test failures.
   */
  public async executeWithCircuitBreaker<T>(
    name: string,
    executionFn: () => Promise<T>
  ): Promise<T> {
    if (this.isSkillTripped(name)) {
      const remainingCooldown = Math.max(
        0,
        this.COOLDOWN_MS - (Date.now() - (this.trippedAtTimestamps.get(name) ?? 0))
      );
      throw new SkillCircuitBreakerError(
        name,
        `Circuit breaker is tripped for skill "${name}". Cooldown remaining: ${Math.round(
          remainingCooldown / 1000
        )}s.`
      );
    }

    try {
      const result = await executionFn();
      this.recordSuccess(name);
      return result;
    } catch (err: any) {
      // Check if the error is a test/compilation failure (which should NOT trip circuit)
      const isValidationGateFailure =
        err?.message?.includes("Quality gate failed") ||
        err?.message?.includes("compile and validation checks failed") ||
        err?.message?.includes("test suite failed") ||
        err?.message?.includes("gate failed");

      if (!isValidationGateFailure) {
        // Strict execution exception/permission crash -> Record failure
        this.recordFailure(name);
      }
      throw err;
    }
  }
}
