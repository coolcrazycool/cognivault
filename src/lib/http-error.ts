/**
 * An error the global error handler renders verbatim as
 * `{ error: { code, message } }` with the status it carries.
 *
 * `expose` is what separates a message written FOR the caller from an internal failure:
 * `src/plugins/error-handler.ts` replaces the text of every other 5xx with "Internal
 * server error", which is right for a stack trace and wrong for "the collection is
 * blocked, and here is what to do about it".
 */
export interface HttpError extends Error {
  statusCode: number;
  code: string;
  expose: true;
}

/** Build an {@link HttpError}. Throw it from anywhere a route can reach. */
export function httpError(statusCode: number, code: string, message: string): HttpError {
  return Object.assign(new Error(message), { statusCode, code, expose: true as const });
}

/** Whether an unknown value is an error whose code and message are meant for the caller. */
export function isHttpError(err: unknown): err is HttpError {
  return (
    typeof err === 'object' &&
    err !== null &&
    (err as { expose?: unknown }).expose === true &&
    typeof (err as { code?: unknown }).code === 'string'
  );
}
