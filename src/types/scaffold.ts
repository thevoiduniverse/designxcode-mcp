/**
 * Types for component scaffolding (React + Storybook generation).
 */

export interface ComponentProp {
  name: string;
  type: "boolean" | "string" | "enum";
  values?: string[];
  defaultValue?: string;
}

export interface ScaffoldedFile {
  path: string;
  content: string;
  description: string;
}

export interface ScaffoldedComponent {
  componentName: string;
  figmaName: string;
  files: ScaffoldedFile[];
  props: ComponentProp[];
  variants: number;
}
