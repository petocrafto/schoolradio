import { ApiError, handleApi } from "./core.mjs";

/**
 * Adapts the shared API router to the Vercel Node function signature.
 * `pathname` is fixed per function file so routing never depends on rewrites.
 */
export function route(pathname) {
  return async function handler(request, response) {
    try {
      const url = new URL(request.url || pathname, `http://${request.headers.host || "localhost"}`);
      let body = request.body;
      if (typeof body === "string") {
        try {
          body = body ? JSON.parse(body) : null;
        } catch {
          body = null;
        }
      }
      const forwarded = request.headers["x-forwarded-for"];
      const result = await handleApi({
        method: request.method || "GET",
        pathname,
        searchParams: url.searchParams,
        headers: request.headers,
        body: body ?? null,
        ip: typeof forwarded === "string" && forwarded ? forwarded.split(",")[0].trim() : "unknown",
      });
      response.statusCode = result.status;
      response.setHeader("content-type", "application/json; charset=utf-8");
      response.setHeader("cache-control", "no-store");
      response.end(JSON.stringify(result.body));
    } catch (error) {
      const status = error instanceof ApiError ? error.status : 500;
      if (status >= 500) console.error(`[${request.method} ${pathname}]`, error.message);
      response.statusCode = status;
      response.setHeader("content-type", "application/json; charset=utf-8");
      response.setHeader("cache-control", "no-store");
      response.end(JSON.stringify({ error: status >= 500 ? "Something went wrong. Please try again." : error.message }));
    }
  };
}
