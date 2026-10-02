export async function enableNotifications(): Promise<NotificationPermission | "unsupported"> {
  if (!("Notification" in window)) return "unsupported";
  return Notification.requestPermission();
}

export function notify(title: string, body: string): void {
  if ("Notification" in window && Notification.permission === "granted") {
    new Notification(title, { body, icon: "/pwa-icon.svg" });
  }
}
