import type { ButtonHTMLAttributes } from "react";

type Look = "filled" | "tonal" | "outline" | "glass-icon";

const LOOKS: Record<Look, string> = {
  filled: "bg-brand text-on-brand shadow-sm hover:brightness-110",
  tonal: "bg-brand/12 text-brand hover:bg-brand/18",
  outline: "border border-line bg-surface text-ink hover:bg-ground",
  "glass-icon": "glass text-ink shadow-md border border-line/60",
};

export function buttonClass(look: Look, size: "lg" | "md" = "md", extra = ""): string {
  const height = look === "glass-icon" ? "h-11 w-11 justify-center rounded-full p-0" : size === "lg" ? "min-h-14 px-5 text-lg" : "min-h-11 px-4 text-[15px]";
  const shape = look === "glass-icon" ? "" : "rounded-control";
  return `inline-flex items-center gap-2 font-semibold transition-[filter,background-color] duration-(--dur-1) disabled:opacity-55 disabled:cursor-not-allowed ${shape} ${height} ${LOOKS[look]} ${extra}`;
}

export function Button({
  look = "filled",
  size = "md",
  className = "",
  type = "button",
  ...rest
}: ButtonHTMLAttributes<HTMLButtonElement> & { look?: Look; size?: "lg" | "md" }) {
  return <button type={type} className={buttonClass(look, size, className)} {...rest} />;
}
