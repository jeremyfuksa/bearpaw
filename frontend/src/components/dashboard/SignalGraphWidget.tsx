import { useEffect, useRef } from 'react';
import { WidgetCard } from './WidgetCard';
import type { RSSIPoint } from './types';

interface SignalGraphWidgetProps {
  rssiHistory: RSSIPoint[];
  loading?: boolean;
}

export function SignalGraphWidget({ rssiHistory, loading }: SignalGraphWidgetProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    if (!canvasRef.current || !rssiHistory || rssiHistory.length === 0) {
      return;
    }

    const canvas = canvasRef.current;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    // Set canvas size to match display size
    const rect = canvas.getBoundingClientRect();
    canvas.width = rect.width * window.devicePixelRatio;
    canvas.height = rect.height * window.devicePixelRatio;
    ctx.scale(window.devicePixelRatio, window.devicePixelRatio);

    const width = rect.width;
    const height = rect.height;
    const padding = 40;
    const graphWidth = width - padding * 2;
    const graphHeight = height - padding * 2;

    // Clear canvas
    ctx.clearRect(0, 0, width, height);

    // Draw background
    ctx.fillStyle = '#1a1a1a';
    ctx.fillRect(0, 0, width, height);

    // Find min/max RSSI for scaling
    const rssiValues = rssiHistory.map((p) => p.rssi);
    const minRSSI = Math.min(...rssiValues);
    const maxRSSI = Math.max(...rssiValues);
    const rssiRange = maxRSSI - minRSSI || 1;

    // Draw grid lines
    ctx.strokeStyle = '#333';
    ctx.lineWidth = 1;
    for (let i = 0; i <= 4; i++) {
      const y = padding + (graphHeight / 4) * i;
      ctx.beginPath();
      ctx.moveTo(padding, y);
      ctx.lineTo(padding + graphWidth, y);
      ctx.stroke();
    }

    // Draw RSSI labels
    ctx.fillStyle = '#999';
    ctx.font = '12px monospace';
    ctx.textAlign = 'right';
    for (let i = 0; i <= 4; i++) {
      const rssi = maxRSSI - (rssiRange / 4) * i;
      const y = padding + (graphHeight / 4) * i + 4;
      ctx.fillText(rssi.toFixed(0), padding - 8, y);
    }

    // Draw line graph
    if (rssiHistory.length > 1) {
      ctx.strokeStyle = '#00ff88';
      ctx.lineWidth = 2;
      ctx.beginPath();

      rssiHistory.forEach((point, index) => {
        const x = padding + (graphWidth / (rssiHistory.length - 1)) * index;
        const normalizedRSSI = (point.rssi - minRSSI) / rssiRange;
        const y = padding + graphHeight - normalizedRSSI * graphHeight;

        if (index === 0) {
          ctx.moveTo(x, y);
        } else {
          ctx.lineTo(x, y);
        }
      });

      ctx.stroke();
    }

    // Draw current RSSI value
    if (rssiHistory.length > 0) {
      const current = rssiHistory[rssiHistory.length - 1];
      ctx.fillStyle = '#00ff88';
      ctx.font = 'bold 16px monospace';
      ctx.textAlign = 'left';
      ctx.fillText(`${current.rssi}`, padding + 4, padding + 20);
    }
  }, [rssiHistory]);

  if (loading) {
    return (
      <WidgetCard title="Signal Strength">
        <div className="dashboard-loading">Loading...</div>
      </WidgetCard>
    );
  }

  return (
    <WidgetCard title="Signal Strength">
      <canvas ref={canvasRef} className="signal-graph-canvas" />
    </WidgetCard>
  );
}
