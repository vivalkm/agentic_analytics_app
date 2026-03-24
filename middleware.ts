import { NextResponse, type NextRequest } from 'next/server';

export default function middleware(_request: NextRequest) {
  // Auth enforcement is handled in individual API routes via auth().
  // When Okta env vars are set, the auth() call enforces login.
  // When they're not set, auth() returns null and routes allow anonymous access.
  return NextResponse.next();
}

export const config = {
  matcher: [
    '/((?!api/auth|_next/static|_next/image|favicon.ico).*)',
  ],
};
