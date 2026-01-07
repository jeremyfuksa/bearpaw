/**
 * Formats a timestamp as relative time (e.g., "5 minutes ago")
 * @param timestamp - Unix timestamp in seconds
 * @param now - Current time in seconds (defaults to Date.now()/1000)
 */
export function formatRelativeTime(timestamp: number, now?: number): string {
  const currentTime = now ?? Date.now() / 1000;
  const diffSeconds = Math.floor(currentTime - timestamp);

  // Under 60 seconds: "X seconds ago" or "now"
  if (diffSeconds < 60) {
    if (diffSeconds === 0) return 'now';
    return diffSeconds === 1 ? '1 second ago' : `${diffSeconds} seconds ago`;
  }

  // Under 60 minutes: "X minutes ago"
  const diffMinutes = Math.floor(diffSeconds / 60);
  if (diffMinutes < 60) {
    return diffMinutes === 1 ? '1 minute ago' : `${diffMinutes} minutes ago`;
  }

  // Under 24 hours: "X hours ago"
  const diffHours = Math.floor(diffMinutes / 60);
  if (diffHours < 24) {
    return diffHours === 1 ? '1 hour ago' : `${diffHours} hours ago`;
  }

  // Under 7 days: "X days ago"
  const diffDays = Math.floor(diffHours / 24);
  if (diffDays < 7) {
    return diffDays === 1 ? '1 day ago' : `${diffDays} days ago`;
  }

  // Under 30 days: "X weeks ago"
  const diffWeeks = Math.floor(diffDays / 7);
  if (diffDays < 30) {
    return diffWeeks === 1 ? '1 week ago' : `${diffWeeks} weeks ago`;
  }

  // Under 365 days: "X months ago"
  const diffMonths = Math.floor(diffDays / 30);
  if (diffDays < 365) {
    return diffMonths === 1 ? '1 month ago' : `${diffMonths} months ago`;
  }

  // Beyond that: "X years ago"
  const diffYears = Math.floor(diffDays / 365);
  return diffYears === 1 ? '1 year ago' : `${diffYears} years ago`;
}
