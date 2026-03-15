/**
 * Resolves Figma boundVariables to CSS custom property references.
 * Each Figma node property can be bound to a variable (design token).
 * This resolver looks up the variable by ID and converts it to a CSS var() reference.
 */

import type {
  FigmaVariable,
  FigmaVariableAlias,
  FigmaColor,
} from "../types/figma.js";
import type { ResolvedValue } from "../types/node-ir.js";
import { figmaColorToHex } from "./w3c-tokens.js";
import { sanitizeTokenName } from "./w3c-tokens.js";

export class VariableResolver {
  private variables: Record<string, FigmaVariable>;

  constructor(variables: Record<string, FigmaVariable>) {
    this.variables = variables;
  }

  /**
   * Resolve a variable alias binding to a CSS value.
   * Returns var(--token-name) for web, literal for React Native.
   * Returns null if the variable ID isn't found (caller should fall back to raw value).
   */
  resolveBinding(binding: FigmaVariableAlias): ResolvedValue | null {
    const variable = this.variables[binding.id];
    if (!variable) {
      return null;
    }

    const tokenName = this.variableNameToToken(variable.name);
    const literal = this.resolveToLiteral(variable);

    return {
      css: `var(--${tokenName})`,
      isBound: true,
      tokenName,
      literal,
    };
  }

  /**
   * Convert a Figma variable name (e.g., "colors/primary/500") to a
   * CSS custom property name (e.g., "colors-primary-500").
   */
  private variableNameToToken(name: string): string {
    return name
      .split("/")
      .map((segment) => sanitizeTokenName(segment))
      .join("-");
  }

  /**
   * Resolve a variable to its literal value (for React Native or fallback).
   * Follows alias chains to the final value.
   */
  private resolveToLiteral(
    variable: FigmaVariable,
    visited: Set<string> = new Set()
  ): string {
    if (visited.has(variable.id)) return "";
    visited.add(variable.id);

    // Get value from the first available mode
    const value = Object.values(variable.valuesByMode)[0];
    if (value === undefined) return "";

    // Follow alias chain
    if (isAlias(value)) {
      const aliased = this.variables[value.id];
      if (aliased) return this.resolveToLiteral(aliased, visited);
      return "";
    }

    // Resolve based on type
    if (variable.resolvedType === "COLOR" && isColor(value)) {
      return figmaColorToHex(value);
    }

    if (typeof value === "number") {
      return `${value}px`;
    }

    return String(value);
  }

  /**
   * Resolve a raw (unbound) color to hex.
   */
  resolveColor(color: FigmaColor): ResolvedValue {
    const hex = figmaColorToHex(color);
    return { css: hex, isBound: false, literal: hex };
  }

  /**
   * Resolve a numeric value, checking boundVariables first.
   * @param value - The raw numeric value from the node
   * @param boundVar - The variable alias if bound, or undefined
   * @param unit - CSS unit to append (default: "px")
   */
  resolveNumber(
    value: number | undefined,
    boundVar: FigmaVariableAlias | undefined,
    unit: string = "px"
  ): ResolvedValue | null {
    if (value === undefined && !boundVar) return null;

    if (boundVar) {
      const resolved = this.resolveBinding(boundVar);
      if (resolved) return resolved;
      // Binding failed — fall through to use raw value
    }

    if (value !== undefined) {
      const literal = `${value}${unit}`;
      return { css: literal, isBound: false, literal };
    }

    return null;
  }

  /**
   * Resolve a fill (solid color or gradient) to a CSS value.
   * @param fill - The Figma paint object
   * @param colorBinding - The variable alias for the color, if bound
   */
  resolveFill(
    fill: { type: string; color?: FigmaColor; opacity?: number; gradientStops?: Array<{ position: number; color: FigmaColor }>; gradientHandlePositions?: Array<{ x: number; y: number }> },
    colorBinding?: FigmaVariableAlias
  ): ResolvedValue | null {
    if (fill.type === "SOLID" && fill.color) {
      if (colorBinding) {
        const resolved = this.resolveBinding(colorBinding);
        if (resolved) return resolved;
        // Binding failed — fall through to use raw color
      }
      const color = { ...fill.color };
      if (fill.opacity !== undefined) {
        color.a = fill.opacity;
      }
      return this.resolveColor(color);
    }

    if (fill.type === "GRADIENT_LINEAR" && fill.gradientStops && fill.gradientHandlePositions) {
      const angle = calculateGradientAngle(fill.gradientHandlePositions);
      const stops = fill.gradientStops
        .map((stop) => {
          const hex = figmaColorToHex(stop.color);
          const pct = Math.round(stop.position * 100);
          return `${hex} ${pct}%`;
        })
        .join(", ");
      const css = `linear-gradient(${angle}deg, ${stops})`;
      return { css, isBound: false, literal: css };
    }

    return null;
  }
}

// ─── Helpers ───

function isAlias(value: unknown): value is FigmaVariableAlias {
  return (
    typeof value === "object" &&
    value !== null &&
    "type" in value &&
    (value as FigmaVariableAlias).type === "VARIABLE_ALIAS"
  );
}

function isColor(value: unknown): value is FigmaColor {
  return (
    typeof value === "object" &&
    value !== null &&
    "r" in value &&
    "g" in value &&
    "b" in value &&
    "a" in value
  );
}

/**
 * Calculate CSS gradient angle from Figma gradient handle positions.
 * Figma uses two points (start and end) in a 0-1 coordinate space.
 */
function calculateGradientAngle(
  handles: Array<{ x: number; y: number }>
): number {
  if (handles.length < 2) return 180;
  const [start, end] = handles;
  const dx = end.x - start.x;
  const dy = end.y - start.y;
  // Convert from Figma's coordinate system to CSS degrees
  // CSS: 0deg = to top, 90deg = to right
  const radians = Math.atan2(dx, -dy);
  let degrees = Math.round((radians * 180) / Math.PI);
  if (degrees < 0) degrees += 360;
  return degrees;
}
