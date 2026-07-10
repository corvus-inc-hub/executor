export interface LoginState {
  readonly nonce: string;
  readonly returnTo?: string;
}

export const encodeLoginState = (state: LoginState): string =>
  Buffer.from(JSON.stringify(state), "utf8").toString("base64url");

export const decodeLoginState = (value: string | null | undefined): LoginState | null => {
  if (!value) return null;
  // oxlint-disable-next-line executor/no-try-catch-or-throw -- boundary: OAuth state is untrusted input
  try {
    // oxlint-disable-next-line executor/no-json-parse -- boundary: decoded OAuth state is validated field by field below
    const decoded = JSON.parse(Buffer.from(value, "base64url").toString("utf8")) as unknown;
    if (!decoded || typeof decoded !== "object") return null;
    const state = decoded as Record<string, unknown>;
    if (typeof state.nonce !== "string") return null;
    if (state.returnTo !== undefined && typeof state.returnTo !== "string") return null;
    return {
      nonce: state.nonce,
      ...(typeof state.returnTo === "string" ? { returnTo: state.returnTo } : {}),
    };
  } catch {
    return null;
  }
};
