// Server (framework-free; no React imports)
export { createNotificationsHandler } from "./server/handler";
export { createInMemoryNotificationStore } from "./server/memory-store";
export type { InMemoryNotificationStore } from "./server/memory-store";
export type {
  DashboardNotification,
  NotificationStatusFilter,
  StoreResult,
  NotificationStore,
  AuthorizeFn,
  LogFn,
  NotificationsHandlerOptions,
} from "./server/types";

// Client (React hook)
export {
  useNotifications,
  loadPreferences,
} from "./client/useNotifications";
export type {
  Notification,
  NotificationPreferences,
  NotificationEndpoints,
  UseNotificationsOptions,
} from "./client/useNotifications";
export {
  createDefaultNotificationsApi,
  toArray,
} from "./client/api";
export type {
  NotificationsClientApi,
  NotificationStreamHandle,
  DefaultNotificationsApiConfig,
} from "./client/api";
