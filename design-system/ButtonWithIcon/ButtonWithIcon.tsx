import { type ButtonHTMLAttributes, type ReactNode, forwardRef } from "react";

const sizeStyles = {
  md: {
    button: "px-6 py-3 gap-3 text-[16px] leading-[1.63]",
    icon: "w-4 h-4",
  },
  sm: {
    button: "px-4 py-2 gap-2 text-[14px] leading-[1.57]",
    icon: "w-4 h-4",
  },
} as const;

export type ButtonWithIconSize = keyof typeof sizeStyles;

export interface ButtonWithIconProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  size?: ButtonWithIconSize;
  icon?: ReactNode;
}

export const ButtonWithIcon = forwardRef<HTMLButtonElement, ButtonWithIconProps>(
  ({ size = "md", icon, className = "", children, ...props }, ref) => {
    const styles = sizeStyles[size];

    return (
      <button
        ref={ref}
        className={[
          "inline-flex flex-row items-center justify-center",
          "[font-family:'Google_Sans',sans-serif] font-[500]",
          "text-[#0a0d14] border border-[#e5e7eb] rounded-full bg-transparent",
          "transition-colors hover:bg-[#f3f6fa] active:bg-[#e5e7eb]",
          "focus:outline-none focus-visible:ring-2 focus-visible:ring-[#e5e7eb] focus-visible:ring-offset-2",
          "disabled:opacity-25 disabled:pointer-events-none",
          styles.button,
          className,
        ]
          .filter(Boolean)
          .join(" ")}
        {...props}
      >
        {icon && <span className={`flex-shrink-0 ${styles.icon}`}>{icon}</span>}
        {children}
      </button>
    );
  }
);

ButtonWithIcon.displayName = "ButtonWithIcon";
