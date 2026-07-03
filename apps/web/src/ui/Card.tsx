import type { HTMLAttributes } from 'react';

export function Card({ className = '', ...props }: HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      className={`rounded-card border border-line bg-surface p-4 shadow-card ${className}`}
      {...props}
    />
  );
}
