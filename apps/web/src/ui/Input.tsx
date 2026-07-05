import { forwardRef, type InputHTMLAttributes } from 'react';

export const Input = forwardRef<HTMLInputElement, InputHTMLAttributes<HTMLInputElement>>(
  function Input({ type = 'text', className = '', ...rest }, ref) {
    return (
      <input
        ref={ref}
        type={type}
        className={`rounded-control border border-line bg-surface px-3 py-2 text-text placeholder:text-text-muted focus:outline-none focus:ring-2 focus:ring-accent ${className}`}
        {...rest}
      />
    );
  },
);
