import type { Notification } from "../types";

interface NotificationCenterProps {
  notifications: Notification[];
  onDismiss: (id: string) => void;
}

export function NotificationCenter({ notifications, onDismiss }: NotificationCenterProps) {
  return (
    <div className="notification-center" role="status" aria-live="polite">
      {notifications.map((notification) => (
        <div key={notification.id} className={`toast ${notification.type}`}>
          <span>{notification.message}</span>
          <button
            className="icon-button"
            type="button"
            onClick={() => onDismiss(notification.id)}
            aria-label="Dismiss notification"
          >
            ×
          </button>
        </div>
      ))}
    </div>
  );
}
