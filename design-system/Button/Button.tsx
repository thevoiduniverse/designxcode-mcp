import { type ButtonHTMLAttributes, forwardRef } from "react";

const typeStyles = {
  primary: {
    base: "bg-[#d51e8b] text-[#fafbfc] shadow-[0_1px_2px_rgba(0,0,0,0.1)]",
    hover: "hover:bg-[#b8187a]",
    active: "active:bg-[#d51e8b]",
    focus: "focus-visible:ring-2 focus-visible:ring-[#d51e8b]/50 focus-visible:ring-offset-2",
    disabled: "disabled:opacity-25",
  },
  outline: {
    base: "border border-[#e5e7eb] text-[#0a0d14] bg-transparent",
    hover: "hover:bg-[#f3f6fa]",
    active: "active:bg-[#e5e7eb]",
    focus: "focus-visible:ring-2 focus-visible:ring-[#e5e7eb] focus-visible:ring-offset-2",
    disabled: "disabled:opacity-25",
  },
  ghost: {
    base: "text-[#6b7280] bg-transparent",
    hover: "hover:bg-[#f3f6fa] hover:text-[#0a0d14]",
    active: "active:bg-[#e5e7eb] active:text-[#0a0d14]",
    focus: "focus-visible:ring-2 focus-visible:ring-[#6b7280]/50 focus-visible:ring-offset-2",
    disabled: "disabled:opacity-25",
  },
} as const;

const sizeStyles = {
  md: "px-6 py-3 text-base",
  sm: "px-4 py-2 text-sm",
} as const;

export type ButtonType = keyof typeof typeStyles;
export type ButtonSize = keyof typeof sizeStyles;

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonType;
  size?: ButtonSize;
}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(
  ({ variant = "primary", size = "md", className = "", children, ...props }, ref) => {
    const styles = typeStyles[variant];

    return (
      <button
        ref={ref}
        className={[
          "inline-flex items-center justify-center font-medium rounded-full transition-colors",
          "focus:outline-none disabled:pointer-events-none",
          sizeStyles[size],
          styles.base,
          styles.hover,
          styles.active,
          styles.focus,
          styles.disabled,
          className,
        ]
          .filter(Boolean)
          .join(" ")}
        {...props}
      >
        {children}
      </button>
    );
  }
);

Button.displayName = "Button";
