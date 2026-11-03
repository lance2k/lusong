import type { ReactNode } from "react";

export function Card({ children, className = "", ...rest }: { children: ReactNode; className?: string } & React.HTMLAttributes<HTMLElement>) {
  return (
    <section className={`overflow-hidden rounded-card border border-line bg-surface ${className}`} {...rest}>
      {children}
    </section>
  );
}

export function CardSection({ title, children, className = "" }: { title?: string; children: ReactNode; className?: string }) {
  return (
    <section className={`space-y-1 rounded-card border border-line bg-surface px-4 py-3 text-[15px] ${className}`}>
      {title && <h3 className="text-label uppercase tracking-wide text-ink-2">{title}</h3>}
      {children}
    </section>
  );
}
