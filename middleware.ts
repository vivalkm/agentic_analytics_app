export { auth as default } from '@/auth';

export const config = {
  matcher: [
    // Protect all routes except auth endpoints, static files, and Next.js internals
    '/((?!api/auth|_next/static|_next/image|favicon.ico).*)',
  ],
};
