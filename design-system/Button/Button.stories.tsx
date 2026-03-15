import type { Meta, StoryObj } from "@storybook/react";
import { Button } from "./Button";

const meta = {
  title: "Components/Button",
  component: Button,
  argTypes: {
    variant: {
      control: "select",
      options: ["primary", "outline", "ghost"],
      description: "Visual style of the button",
    },
    size: {
      control: "select",
      options: ["sm", "md"],
      description: "Size of the button",
    },
    disabled: {
      control: "boolean",
    },
    children: {
      control: "text",
    },
  },
  args: {
    children: "Button",
    variant: "primary",
    size: "md",
  },
  parameters: {
    layout: "centered",
  },
} satisfies Meta<typeof Button>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Primary: Story = {
  args: { variant: "primary" },
};

export const Outline: Story = {
  args: { variant: "outline" },
};

export const Ghost: Story = {
  args: { variant: "ghost" },
};

export const Small: Story = {
  args: { size: "sm" },
};

export const Disabled: Story = {
  args: { disabled: true },
};

export const AllVariants: Story = {
  render: () => (
    <div className="flex flex-col gap-6">
      {(["primary", "outline", "ghost"] as const).map((variant) => (
        <div key={variant} className="flex items-center gap-4">
          <span className="w-16 text-sm text-gray-500 capitalize">{variant}</span>
          <Button variant={variant} size="md">Button</Button>
          <Button variant={variant} size="sm">Button</Button>
          <Button variant={variant} size="md" disabled>Button</Button>
          <Button variant={variant} size="sm" disabled>Button</Button>
        </div>
      ))}
    </div>
  ),
};
