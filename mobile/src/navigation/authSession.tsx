import { createContext, useContext } from 'react';

export type AuthSessionContextValue = {
  signOut: () => Promise<void>;
};

export const AuthSessionContext = createContext<AuthSessionContextValue>({
  /**
   * Provide a harmless default sign-out operation when a component is outside the session
   * provider.
   */
  signOut: async () => {},
});

/**
 * Read the navigation-owned sign-out interface without coupling screens to Firebase or onboarding
 * persistence.
 */
export function useAuthSession(): AuthSessionContextValue {
  return useContext(AuthSessionContext);
}
