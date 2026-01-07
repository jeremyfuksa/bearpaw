export interface BusiestChannel {
  rank: number;
  frequency: number;
  alpha_tag: string | null;
  channel: number | null;
  hit_count: number;
  avg_duration: number;
  last_seen: number;
}

export interface HeatmapCell {
  hour: number;
  day: number;
  count: number;
}

export interface SessionStats {
  total_hits: number;
  avg_rssi: number;
  active_time_seconds: number;
  unique_channels: number;
}

export interface RSSIPoint {
  timestamp: number;
  rssi: number;
}
