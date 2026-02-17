import { useEffect } from 'react';
import { addBreadcrumb, clearSentryUser, setSentryUser } from '@/utils/sentry';
import { AuthUser } from '@/api-types';

/**
 * Hook to automatically sync user context with Sentry
 * Use this in your app's root or authentication provider
 */
export function useSentryUser(user: AuthUser | null) {
  useEffect(() => {
    if (user) {
      setSentryUser({
        id: user.id,
        email: user.email,
        username: user.displayName,
      });
    } else {
      clearSentryUser();
    }
  }, [user]);
}

/**
 * Hook to track user actions as breadcrumbs
 */
export function useSentryBreadcrumb() {
  return (message: string, data?: Record<string, any>) => {
    addBreadcrumb(message, 'user-action', 'info', data);
  };
}
