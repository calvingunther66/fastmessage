import {
  API_V1,
  type AuthResponse,
  type ClaimResponse,
  type DeviceListResponse,
  type LoginRequest,
  type RegisterRequest,
  type ReplenishRequest,
  type UserLookupResponse,
} from "@fastmessage/shared";

export class ApiError extends Error {
  constructor(
    public status: number,
    public code: string,
    detail?: string,
  ) {
    super(detail ? `${code}: ${detail}` : code);
  }
}

async function req<T>(
  path: string,
  opts: { method?: string; token?: string; body?: unknown } = {},
): Promise<T> {
  const res = await fetch(`${API_V1}${path}`, {
    method: opts.method ?? "GET",
    headers: {
      ...(opts.body ? { "content-type": "application/json" } : {}),
      ...(opts.token ? { authorization: `Bearer ${opts.token}` } : {}),
    },
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  if (!res.ok) {
    let code = `http_${res.status}`;
    let detail: string | undefined;
    try {
      const j = (await res.json()) as { error?: string; detail?: string };
      code = j.error ?? code;
      detail = j.detail;
    } catch {
      /* non-JSON error */
    }
    throw new ApiError(res.status, code, detail);
  }
  return (await res.json()) as T;
}

export const api = {
  register: (body: RegisterRequest) =>
    req<AuthResponse>("/auth/register", { method: "POST", body }),
  login: (body: LoginRequest) =>
    req<AuthResponse>("/auth/login", { method: "POST", body }),
  logout: (token: string) =>
    req<{ ok: boolean }>("/auth/logout", { method: "POST", token }),
  lookup: (username: string, token: string) =>
    req<UserLookupResponse>(
      `/users/lookup?username=${encodeURIComponent(username)}`,
      { token },
    ),
  profile: (userId: string, token: string) =>
    req<UserLookupResponse>(`/users/${encodeURIComponent(userId)}`, { token }),
  devices: (userId: string, token: string) =>
    req<DeviceListResponse>(`/devices/${encodeURIComponent(userId)}`, { token }),
  claim: (targets: Array<{ userId: string; deviceId: string }>, token: string) =>
    req<ClaimResponse>("/keys/claim", { method: "POST", token, body: { targets } }),
  replenish: (body: ReplenishRequest, token: string) =>
    req<{ ok: boolean; remaining: number }>("/keys/replenish", {
      method: "POST",
      token,
      body,
    }),
};
