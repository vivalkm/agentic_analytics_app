import NextAuth from 'next-auth';
import Okta from 'next-auth/providers/okta';

/** Auth is enabled only when all Okta env vars are set. */
export const authEnabled = Boolean(
  process.env.AUTH_OKTA_ID &&
  process.env.AUTH_OKTA_SECRET &&
  process.env.AUTH_OKTA_ISSUER
);

const nextAuth = authEnabled
  ? NextAuth({
      providers: [
        Okta({
          clientId: process.env.AUTH_OKTA_ID,
          clientSecret: process.env.AUTH_OKTA_SECRET,
          issuer: process.env.AUTH_OKTA_ISSUER,
        }),
      ],
      session: { strategy: 'jwt' },
      callbacks: {
        jwt({ token, profile }) {
          if (profile) {
            token.email = profile.email as string;
            token.name = profile.name as string;
          }
          return token;
        },
        session({ session, token }) {
          if (session.user) {
            session.user.email = token.email as string;
            session.user.name = token.name as string;
          }
          return session;
        },
      },
      pages: {
        signIn: '/api/auth/signin',
      },
    })
  : null;

export const handlers = nextAuth?.handlers ?? {
  GET: () => new Response('Auth not configured', { status: 404 }),
  POST: () => new Response('Auth not configured', { status: 404 }),
};

/**
 * When auth is disabled, return a default anonymous session so API routes
 * don't block with 401. When auth is enabled, delegates to next-auth.
 */
const anonymousSession = {
  user: { email: 'anonymous@localhost', name: 'Anonymous' },
  expires: new Date(Date.now() + 86400000).toISOString(),
};

export const auth = nextAuth?.auth ?? (async () => anonymousSession);
export const signIn = nextAuth?.signIn ?? (async () => {});
export const signOut = nextAuth?.signOut ?? (async () => {});
