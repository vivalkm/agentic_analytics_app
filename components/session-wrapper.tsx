'use client';

import { createContext, useContext } from 'react';
import { SessionProvider } from 'next-auth/react';

const AuthContext = createContext(false);
export const useAuthEnabled = () => useContext(AuthContext);

export function SessionWrapper({
  authEnabled,
  children,
}: {
  authEnabled: boolean;
  children: React.ReactNode;
}) {
  return (
    <AuthContext.Provider value={authEnabled}>
      {authEnabled ? (
        <SessionProvider>{children}</SessionProvider>
      ) : (
        children
      )}
    </AuthContext.Provider>
  );
}
