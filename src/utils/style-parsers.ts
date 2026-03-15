/**
 * Parsers for extracting style properties from Figma detailed nodes.
 * Converts raw Figma node data into structured style properties.
 */

import type { FigmaColor, FigmaDetailedNode } from "../types/figma.js";
import type {
  FillStyleProperties,
  TextStyleProperties,
  EffectStyleProperties,
  GridStyleProperties,
  ExtractedStyle,
} from "../types/styles.js";

/** Convert a Figma RGBA color to hex string */
function figmaColorToHex(color: FigmaColor): string {
  const r = Math.round(color.r * 255);
  const g = Math.round(color.g * 255);
  const b = Math.round(color.b * 255);
  const a = color.a;

  if (a < 1) {
    const aHex = Math.round(a * 255).toString(16).padStart(2, "0");
    return `#${r.toString(16).padStart(2, "0")}${g.toString(16).padStart(2, "0")}${b.toString(16).padStart(2, "0")}${aHex}`;
  }
  return `#${r.toString(16).padStart(2, "0")}${g.toString(16).padStart(2, "0")}${b.toString(16).padStart(2, "0")}`;
}

/** Extract fill properties from a node */
export function parseNodeFills(node: FigmaDetailedNode): FillStyleProperties {
  const fills = (node.fills ?? [])
    .filter((f) => f.visible !== false)
    .map((fill) => ({
      type: fill.type,
      color: fill.color ? figmaColorToHex(fill.color) : undefined,
      opacity: fill.opacity,
      gradientStops: fill.gradientStops?.map((stop) => ({
        position: stop.position,
        color: figmaColorToHex(stop.color),
      })),
    }));

  return { fills };
}

/** Extract text style properties from a node */
export function parseNodeTextStyle(node: FigmaDetailedNode): TextStyleProperties {
  const s = node.style;
  if (!s) {
    return {
      fontFamily: "unknown",
      fontWeight: 400,
      fontSize: 16,
      letterSpacing: 0,
    };
  }

  return {
    fontFamily: s.fontFamily,
    fontWeight: s.fontWeight,
    fontSize: s.fontSize,
    lineHeight: s.lineHeightPx,
    lineHeightUnit: s.lineHeightUnit,
    letterSpacing: s.letterSpacing,
    textDecoration: s.textDecoration !== "NONE" ? s.textDecoration : undefined,
    textCase: s.textCase !== "ORIGINAL" ? s.textCase : undefined,
  };
}

/** Extract effect properties from a node */
export function parseNodeEffects(node: FigmaDetailedNode): EffectStyleProperties {
  const effects = (node.effects ?? [])
    .filter((e) => e.visible !== false)
    .map((effect) => ({
      type: effect.type,
      color: effect.color ? figmaColorToHex(effect.color) : undefined,
      offset: effect.offset,
      radius: effect.radius,
      spread: effect.spread,
    }));

  return { effects };
}

/** Extract grid properties from a node */
export function parseNodeGrids(node: FigmaDetailedNode): GridStyleProperties {
  const grids = (node.layoutGrids ?? [])
    .filter((g) => g.visible !== false)
    .map((grid) => ({
      pattern: grid.pattern,
      sectionSize: grid.sectionSize,
      gutterSize: grid.gutterSize,
      offset: grid.offset,
      count: grid.count,
      alignment: grid.alignment,
    }));

  return { grids };
}

/** Convert a style name to a CSS custom property name */
function styleToCSSName(name: string): string {
  return name
    .replace(/\//g, "-")
    .replace(/\s+/g, "-")
    .replace(/[^a-zA-Z0-9-]/g, "")
    .toLowerCase();
}

/** Convert extracted styles to CSS custom properties */
export function stylesToCSS(styles: ExtractedStyle[]): string {
  const lines: string[] = [":root {"];

  for (const style of styles) {
    const cssName = styleToCSSName(style.name);

    switch (style.styleType) {
      case "FILL": {
        const fills = (style.properties as FillStyleProperties).fills;
        if (fills.length > 0 && fills[0].color) {
          lines.push(`  --${cssName}: ${fills[0].color};`);
        }
        break;
      }
      case "TEXT": {
        const text = style.properties as TextStyleProperties;
        lines.push(`  --${cssName}-font-family: "${text.fontFamily}";`);
        lines.push(`  --${cssName}-font-weight: ${text.fontWeight};`);
        lines.push(`  --${cssName}-font-size: ${text.fontSize}px;`);
        if (text.lineHeight) {
          lines.push(`  --${cssName}-line-height: ${text.lineHeight}px;`);
        }
        if (text.letterSpacing) {
          lines.push(`  --${cssName}-letter-spacing: ${text.letterSpacing}px;`);
        }
        break;
      }
      case "EFFECT": {
        const effects = (style.properties as EffectStyleProperties).effects;
        const shadowParts = effects
          .filter((e) => e.type === "DROP_SHADOW" || e.type === "INNER_SHADOW")
          .map((e) => {
            const inset = e.type === "INNER_SHADOW" ? "inset " : "";
            const x = e.offset?.x ?? 0;
            const y = e.offset?.y ?? 0;
            const blur = e.radius;
            const spread = e.spread ?? 0;
            const color = e.color ?? "rgba(0,0,0,0.25)";
            return `${inset}${x}px ${y}px ${blur}px ${spread}px ${color}`;
          });
        if (shadowParts.length > 0) {
          lines.push(`  --${cssName}: ${shadowParts.join(", ")};`);
        }
        break;
      }
      case "GRID":
        // Grids don't map cleanly to single CSS vars, skip
        break;
    }
  }

  lines.push("}");
  return lines.join("\n");
}
