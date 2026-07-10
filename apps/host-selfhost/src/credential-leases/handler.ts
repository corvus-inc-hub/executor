import { Effect, Predicate, Result, Schema } from "effect";

import {
  CredentialLeaseError,
  decodeCredentialLeaseRequest,
  makeCredentialLeaseService,
  type CredentialLeaseDeps,
} from "./service";

const MAX_BODY_BYTES = 64 * 1024;

const json = (value: unknown, status: number, headers?: HeadersInit): Response =>
  new Response(JSON.stringify(value), {
    status,
    headers: {
      "content-type": "application/json",
      "cache-control": "no-store",
      pragma: "no-cache",
      ...headers,
    },
  });

const errorResponse = (error: CredentialLeaseError): Response =>
  json(
    { error: error.detail, code: error.code },
    error.status,
    error.status === 401 ? { "www-authenticate": "Bearer" } : undefined,
  );

const invalidBody = (detail: string) =>
  new CredentialLeaseError({ status: 400, code: "invalid_request", detail });

const readBoundedBody = (request: Request) =>
  Effect.tryPromise({
    try: async (): Promise<Uint8Array | CredentialLeaseError> => {
      const reader = request.body?.getReader();
      if (!reader) return new Uint8Array();
      const chunks: Uint8Array[] = [];
      let total = 0;
      while (true) {
        const next = await reader.read();
        if (next.done) break;
        total += next.value.byteLength;
        if (total > MAX_BODY_BYTES) {
          void reader.cancel();
          return invalidBody("Lease request body is too large");
        }
        chunks.push(next.value);
      }
      const body = new Uint8Array(total);
      let offset = 0;
      for (const chunk of chunks) {
        body.set(chunk, offset);
        offset += chunk.byteLength;
      }
      return body;
    },
    catch: () => invalidBody("Lease request body could not be read"),
  });

const parseJsonBody = (body: Uint8Array) =>
  Schema.decodeUnknownEffect(Schema.fromJsonString(Schema.Unknown))(
    new TextDecoder().decode(body),
  ).pipe(Effect.mapError(() => invalidBody("Lease request body must be valid JSON")));

export const makeCredentialLeaseHandler = (deps: CredentialLeaseDeps) => {
  const service = makeCredentialLeaseService(deps);
  return async (request: Request): Promise<Response> => {
    if (request.method !== "POST" || new URL(request.url).pathname !== "/api/credential-leases") {
      return json({ error: "Not found", code: "not_found" }, 404);
    }
    const declaredLength = request.headers.get("content-length");
    if (declaredLength !== null && !/^\d+$/.test(declaredLength)) {
      return errorResponse(invalidBody("Content-Length must be a non-negative integer"));
    }
    if (declaredLength !== null && Number.parseInt(declaredLength, 10) > MAX_BODY_BYTES) {
      return errorResponse(invalidBody("Lease request body is too large"));
    }
    const bodyResult = await Effect.runPromise(
      readBoundedBody(request).pipe(
        Effect.flatMap((body) =>
          Predicate.isTagged("CredentialLeaseError")(body)
            ? Effect.fail(body)
            : parseJsonBody(body),
        ),
        Effect.result,
      ),
    );
    if (Result.isFailure(bodyResult)) return errorResponse(bodyResult.failure);
    const decoded = decodeCredentialLeaseRequest(bodyResult.success);
    if (Predicate.isTagged("CredentialLeaseError")(decoded)) return errorResponse(decoded);
    const result = await Effect.runPromise(service.lease(request, decoded).pipe(Effect.result));
    return Result.isFailure(result)
      ? errorResponse(result.failure)
      : json(result.success, 201, { "x-content-type-options": "nosniff" });
  };
};
