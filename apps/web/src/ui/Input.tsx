import { forwardRef, type InputHTMLAttributes } from 'react';

export const Input = forwardRef<HTMLInputElement, InputHTMLAttributes<HTMLInputElement>>(
  function Input({ type = 'text', className = '', ...rest }, ref) {
    return (
      <input
        ref={ref}
        type={type}
        className={`rounded-control border border-line bg-surface px-3 py-2 text-text transition placeholder:text-text-muted focus-visible:outline-none focus-visible:border-accent focus-visible:ring-2 focus-visible:ring-accent/40 ${className}`}
        {...rest}
      />
    );
  },
);
