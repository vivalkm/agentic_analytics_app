/** Return a JSON 500 response and log the error. */
export function apiError(label: string, error: unknown, status = 500): Response {
  console.error(`${label}:`, error);
  return Response.json(
    { error: error instanceof Error ? error.message : label },
    { status }
  );
}
