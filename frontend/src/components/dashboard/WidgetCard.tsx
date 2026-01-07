import type { ReactNode } from 'react';

interface WidgetCardProps {
  title: string;
  children: ReactNode;
  className?: string;
}

export function WidgetCard({ title, children, className = '' }: WidgetCardProps) {
  return (
    <div className={`dashboard-widget ${className}`}>
      <h3 className="dashboard-widget-title">{title}</h3>
      <div className="dashboard-widget-content">{children}</div>
    </div>
  );
}
