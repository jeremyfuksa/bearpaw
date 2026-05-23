import { useEffect, useLayoutEffect, useRef } from 'react';
import { cn } from '../../lib/utils';

interface FitTextProps {
  /** The string to render. Only single-line strings are supported. */
  children: string;
  /** Classes applied to the rendered text span (font, color, weight, etc.). */
  className?: string;
  /**
   * Minimum font-size in pixels. Defaults to 12px so the text never
   * shrinks below comfortable legibility even if the container is tiny.
   */
  minFontSize?: number;
  /** Optional title attribute for the rendered text. */
  title?: string;
}

/**
 * One-line text that auto-shrinks its font-size when the natural width
 * exceeds the container. The "natural" size comes from whatever
 * font-size class the caller passes in (typically a `text-[clamp(…)]`
 * with cqmin units), so the fluid-type scaling continues to work; this
 * component only kicks in as a *cap* when the text would otherwise
 * overflow.
 *
 * The visible text never truncates and never wraps to a second line.
 * It just gets smaller until it fits.
 */
export function FitText({ children, className, minFontSize = 12, title }: FitTextProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const textRef = useRef<HTMLSpanElement | null>(null);

  // useLayoutEffect so the first paint already shows the fitted size
  // (no flash of overflowing text). Falls back to useEffect on the
  // server where useLayoutEffect would warn.
  const useIsomorphicLayoutEffect = typeof window === 'undefined' ? useEffect : useLayoutEffect;

  useIsomorphicLayoutEffect(() => {
    const container = containerRef.current;
    const text = textRef.current;
    if (!container || !text) return;

    let rafId = 0;
    const fit = () => {
      cancelAnimationFrame(rafId);
      rafId = requestAnimationFrame(() => {
        // Reset any prior inline override so the natural (clamp-based)
        // size from the className can take effect, then measure.
        text.style.fontSize = '';
        const cw = container.clientWidth;
        if (cw === 0) return;
        const tw = text.scrollWidth;
        if (tw <= cw) return;
        const natural = parseFloat(getComputedStyle(text).fontSize);
        if (!Number.isFinite(natural) || natural <= 0) return;
        const scaled = Math.max(minFontSize, Math.floor((cw / tw) * natural));
        text.style.fontSize = `${scaled}px`;
      });
    };

    fit();
    const observer = new ResizeObserver(fit);
    observer.observe(container);
    return () => {
      cancelAnimationFrame(rafId);
      observer.disconnect();
    };
  }, [children, minFontSize, useIsomorphicLayoutEffect]);

  return (
    <div ref={containerRef} className="block w-full">
      <span ref={textRef} title={title} className={cn('block whitespace-nowrap', className)}>
        {children}
      </span>
    </div>
  );
}
