export type NotificationQuietHoursPreference = {
  quietStart?: string | null;
  quietEnd?: string | null;
};

export function resolveNotificationQuietHours(preferences: NotificationQuietHoursPreference[]) {
  const scheduled = preferences.find((item) => item.quietStart && item.quietEnd);
  return scheduled?.quietStart && scheduled.quietEnd
    ? { enabled: true, start: scheduled.quietStart, end: scheduled.quietEnd }
    : { enabled: false, start: "22:00", end: "07:00" };
}

export function notificationQuietHoursPayload(enabled: boolean, start: string, end: string) {
  return enabled
    ? { quietStart: start, quietEnd: end }
    : { quietStart: null, quietEnd: null };
}
