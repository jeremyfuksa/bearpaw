import { useCallback, useState } from 'react';

import type { Notification } from '../types';

export function useNotifications() {
  const [notifications, setNotifications] = useState<Notification[]>([]);

  const removeNotification = useCallback((id: string) => {
    setNotifications((prev) => prev.filter((item) => item.id !== id));
  }, []);

  const addNotification = useCallback(
    (notification: Omit<Notification, 'id'>) => {
      const id = crypto.randomUUID();
      const payload: Notification = { id, ...notification };
      setNotifications((prev) => [...prev, payload]);

      if (notification.duration) {
        window.setTimeout(() => removeNotification(id), notification.duration);
      }
    },
    [removeNotification],
  );

  return { notifications, addNotification, removeNotification };
}
