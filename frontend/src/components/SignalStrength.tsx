interface SignalStrengthProps {
  rssi: number;
}

function getSignalIcon(value: number) {
  if (value < 20) return "fa-signal-weak";
  if (value < 40) return "fa-signal-fair";
  if (value < 60) return "fa-signal-good";
  if (value < 80) return "fa-signal-strong";
  return "fa-signal";
}

function getSignalColor(value: number) {
  if (value < 40) return "var(--signal-low)";
  if (value < 70) return "var(--signal-mid)";
  return "var(--signal-high)";
}

export function SignalStrength({ rssi }: SignalStrengthProps) {
  const icon = getSignalIcon(rssi);
  const color = getSignalColor(rssi);

  return (
    <i
      className={`fa-solid ${icon} signal-icon`}
      style={{ color }}
      aria-label={`Signal strength: ${rssi} percent`}
      title={`${rssi}%`}
    />
  );
}
