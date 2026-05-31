import { z } from "zod";

export class CoercionLayer {
  /**
   * Coerces tool arguments to match a dynamic JSON schema.
   */
  public coerceJsonSchema(
    args: Record<string, any>,
    schema: Record<string, any>
  ): Record<string, any> {
    const coerced = { ...args };
    const properties = schema.properties || {};

    for (const [key, prop] of Object.entries(properties) as [string, any][]) {
      if (coerced[key] === undefined) continue;

      const val = coerced[key];
      const type = prop.type;

      if (type === "boolean" && typeof val !== "boolean") {
        if (val === "true" || val === 1 || val === "1") {
          coerced[key] = true;
        } else if (val === "false" || val === 0 || val === "0") {
          coerced[key] = false;
        }
      } else if (type === "number" && typeof val !== "number") {
        const num = Number(val);
        if (!isNaN(num)) {
          coerced[key] = num;
        }
      } else if (type === "integer" && !Number.isInteger(val)) {
        const num = parseInt(val, 10);
        if (!isNaN(num)) {
          coerced[key] = num;
        }
      } else if (type === "array" && !Array.isArray(val)) {
        // If LLM returned single item instead of array
        coerced[key] = [val];
      }
    }

    return coerced;
  }

  /**
   * Coerces tool arguments and validates them against a Zod schema.
   */
  public coerceAndValidateZod<T extends z.ZodTypeAny>(
    args: Record<string, any>,
    zodSchema: T
  ): { success: boolean; data?: z.infer<T>; errors?: string[] } {
    // We can use dynamic Zod coercion if we wrap types,
    // but a pre-coercion scan makes sure we support standard inputs.
    try {
      const parsed = zodSchema.safeParse(args);
      if (parsed.success) {
        return { success: true, data: parsed.data };
      }

      // Try pre-coercing common mismatch types manually
      const coercedArgs = this.autoCoerceForZod(args, zodSchema);
      const parsedCoerced = zodSchema.safeParse(coercedArgs);

      if (parsedCoerced.success) {
        return { success: true, data: parsedCoerced.data };
      }

      return {
        success: false,
        errors: parsedCoerced.error.errors.map((e) => `${e.path.join(".")}: ${e.message}`),
      };
    } catch (err) {
      return {
        success: false,
        errors: [err instanceof Error ? err.message : String(err)],
      };
    }
  }

  private autoCoerceForZod(args: Record<string, any>, zodSchema: any): Record<string, any> {
    const coerced = { ...args };
    if (!zodSchema || typeof zodSchema.shape !== "object") {
      return coerced;
    }

    for (const [key, field] of Object.entries(zodSchema.shape) as [string, any][]) {
      if (coerced[key] === undefined) continue;

      const val = coerced[key];
      let defType = field;

      // Unwrap optional/nullable types
      if (field._def && field._def.innerType) {
        defType = field._def.innerType;
      }

      const typeName = defType._def?.typeName;

      if (typeName === "ZodBoolean" && typeof val !== "boolean") {
        if (val === "true" || val === 1 || val === "1") {
          coerced[key] = true;
        } else if (val === "false" || val === 0 || val === "0") {
          coerced[key] = false;
        }
      } else if (typeName === "ZodNumber" && typeof val !== "number") {
        const num = Number(val);
        if (!isNaN(num)) {
          coerced[key] = num;
        }
      }
    }

    return coerced;
  }
}
