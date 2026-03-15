/**
 * Templates for generating React component and Storybook story code.
 */

import type { ComponentProp } from "../types/scaffold.js";

/** Convert a string to PascalCase */
export function toPascalCase(name: string): string {
  return name
    .replace(/[^a-zA-Z0-9]+(.)/g, (_, c: string) => c.toUpperCase())
    .replace(/^[a-z]/, (c) => c.toUpperCase())
    .replace(/[^a-zA-Z0-9]/g, "");
}

/** Convert a string to camelCase */
export function toCamelCase(name: string): string {
  const pascal = toPascalCase(name);
  return pascal.charAt(0).toLowerCase() + pascal.slice(1);
}

/** Generate a TypeScript prop type for a component prop */
function propTypeString(prop: ComponentProp): string {
  switch (prop.type) {
    case "boolean":
      return "boolean";
    case "enum":
      return prop.values?.map((v) => `"${v}"`).join(" | ") ?? "string";
    case "string":
    default:
      return "string";
  }
}

/** Generate a React functional component with TypeScript props interface */
export function generateReactComponent(
  name: string,
  props: ComponentProp[],
  tokenPrefix?: string
): string {
  const pascalName = toPascalCase(name);
  const lines: string[] = [];

  lines.push(`import React from "react";`);
  lines.push("");

  // Props interface
  if (props.length > 0) {
    lines.push(`export interface ${pascalName}Props {`);
    for (const prop of props) {
      const camelProp = toCamelCase(prop.name);
      const optional = prop.defaultValue !== undefined ? "?" : "";
      lines.push(`  /** ${prop.name} ${prop.values ? `(${prop.values.join(", ")})` : ""} */`);
      lines.push(`  ${camelProp}${optional}: ${propTypeString(prop)};`);
    }
    lines.push(`  children?: React.ReactNode;`);
    lines.push(`}`);
  } else {
    lines.push(`export interface ${pascalName}Props {`);
    lines.push(`  children?: React.ReactNode;`);
    lines.push(`}`);
  }

  lines.push("");

  // Component
  const defaultAssignments = props
    .filter((p) => p.defaultValue !== undefined)
    .map((p) => {
      const camelProp = toCamelCase(p.name);
      const defaultVal =
        p.type === "boolean"
          ? p.defaultValue
          : `"${p.defaultValue}"`;
      return `  ${camelProp} = ${defaultVal},`;
    });

  lines.push(`export const ${pascalName}: React.FC<${pascalName}Props> = ({`);
  for (const assignment of defaultAssignments) {
    lines.push(assignment);
  }
  const nonDefaultProps = props.filter((p) => p.defaultValue === undefined);
  for (const prop of nonDefaultProps) {
    lines.push(`  ${toCamelCase(prop.name)},`);
  }
  lines.push(`  children,`);
  lines.push(`}) => {`);

  // Build className logic
  if (tokenPrefix) {
    lines.push(`  const baseClass = "${tokenPrefix}-${name.toLowerCase().replace(/\s+/g, "-")}";`);
  } else {
    lines.push(`  const baseClass = "${name.toLowerCase().replace(/\s+/g, "-")}";`);
  }

  lines.push("");
  lines.push(`  return (`);
  lines.push(`    <div className={baseClass}>`);
  lines.push(`      {children}`);
  lines.push(`    </div>`);
  lines.push(`  );`);
  lines.push(`};`);
  lines.push("");
  lines.push(`export default ${pascalName};`);
  lines.push("");

  return lines.join("\n");
}

/** Generate a Storybook stories file */
export function generateStorybook(
  name: string,
  props: ComponentProp[]
): string {
  const pascalName = toPascalCase(name);
  const lines: string[] = [];

  lines.push(`import type { Meta, StoryObj } from "@storybook/react";`);
  lines.push(`import { ${pascalName} } from "./${pascalName}";`);
  lines.push("");
  lines.push(`const meta: Meta<typeof ${pascalName}> = {`);
  lines.push(`  title: "Components/${pascalName}",`);
  lines.push(`  component: ${pascalName},`);

  // Add argTypes for each prop
  if (props.length > 0) {
    lines.push(`  argTypes: {`);
    for (const prop of props) {
      const camelProp = toCamelCase(prop.name);
      if (prop.type === "boolean") {
        lines.push(`    ${camelProp}: { control: "boolean" },`);
      } else if (prop.type === "enum" && prop.values) {
        lines.push(`    ${camelProp}: {`);
        lines.push(`      control: "select",`);
        lines.push(`      options: [${prop.values.map((v) => `"${v}"`).join(", ")}],`);
        lines.push(`    },`);
      } else {
        lines.push(`    ${camelProp}: { control: "text" },`);
      }
    }
    lines.push(`  },`);
  }

  lines.push(`};`);
  lines.push("");
  lines.push(`export default meta;`);
  lines.push(`type Story = StoryObj<typeof ${pascalName}>;`);
  lines.push("");

  // Default story
  lines.push(`export const Default: Story = {`);
  if (props.length > 0) {
    lines.push(`  args: {`);
    for (const prop of props) {
      const camelProp = toCamelCase(prop.name);
      if (prop.defaultValue !== undefined) {
        const val =
          prop.type === "boolean"
            ? prop.defaultValue
            : `"${prop.defaultValue}"`;
        lines.push(`    ${camelProp}: ${val},`);
      }
    }
    lines.push(`  },`);
  }
  lines.push(`};`);
  lines.push("");

  return lines.join("\n");
}

/**
 * Generate a Storybook stories.json manifest from generated components.
 * This enables audit_system_health to check component parity without
 * needing a full Storybook build.
 */
export function generateStorybookManifest(
  components: Array<{ name: string; outputDir: string }>
): string {
  const stories: Record<string, {
    id: string;
    title: string;
    name: string;
    importPath: string;
  }> = {};

  for (const comp of components) {
    const pascal = toPascalCase(comp.name);
    const storyId = `components-${pascal.toLowerCase()}--default`;
    stories[storyId] = {
      id: storyId,
      title: `Components/${pascal}`,
      name: "Default",
      importPath: `./${comp.outputDir}/${pascal}/${pascal}.stories.tsx`,
    };
  }

  return JSON.stringify({ v: 5, entries: stories }, null, 2);
}

/** Generate a barrel export file for multiple components */
export function generateIndexBarrel(componentNames: string[]): string {
  return componentNames
    .map((name) => {
      const pascal = toPascalCase(name);
      return `export { ${pascal}, type ${pascal}Props } from "./${pascal}";`;
    })
    .join("\n") + "\n";
}
