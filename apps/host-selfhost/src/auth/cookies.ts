export const parseCookie = (cookieHeader: string | null, name: string): string | null => {
  if (!cookieHeader) return null;
  const match = cookieHeader
    .split(";")
    .map((cookie) => cookie.trim())
    .find((cookie) => cookie.startsWith(`${name}=`));
  return match ? match.slice(name.length + 1) || null : null;
};

export const serializeCookie = (
  name: string,
  value: string,
  options: {
    readonly maxAge: number;
    readonly secure: boolean;
    readonly httpOnly?: boolean;
  },
): string =>
  [
    `${name}=${value}`,
    "Path=/",
    `Max-Age=${options.maxAge}`,
    "SameSite=Lax",
    ...(options.httpOnly === false ? [] : ["HttpOnly"]),
    ...(options.secure ? ["Secure"] : []),
  ].join("; ");
