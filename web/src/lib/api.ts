import {
  API_V1,
  type AuthResponse,
  type ClaimResponse,
  type CreateGroupRequest,
  type DeviceListResponse,
  type GroupInfo,
  type GroupListResponse,
  type LinkClaimRequest,
  type LinkStartResponse,
  type LoginRequest,
  type PushSubscribeRequest,
  type RegisterRequest,
  type ReplenishRequest,
  type TurnResponse,
  type UserLookupResponse,
  type VapidResponse,
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
  linkStart: (token: string) =>
    req<LinkStartResponse>("/devices/link/start", { method: "POST", token }),
  linkClaim: (body: LinkClaimRequest) =>
    req<AuthResponse>("/devices/link/claim", { method: "POST", body }),
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
  createGroup: (body: CreateGroupRequest, token: string) =>
    req<GroupInfo>("/groups", { method: "POST", token, body }),
  listGroups: (token: string) => req<GroupListResponse>("/groups", { token }),
  getGroup: (groupId: string, token: string) =>
    req<GroupInfo>(`/groups/${encodeURIComponent(groupId)}`, { token }),
  addMember: (groupId: string, userId: string, token: string) =>
    req<GroupInfo>(`/groups/${encodeURIComponent(groupId)}/members`, {
      method: "POST",
      token,
      body: { userId },
    }),
  async uploadBlob(
    data: Uint8Array<ArrayBuffer>,
    token: string,
  ): Promise<{ blobId: string }> {
    const res = await fetch(`${API_V1}/blobs`, {
      method: "POST",
      headers: {
        "content-type": "application/octet-stream",
        authorization: `Bearer ${token}`,
      },
      body: data,
    });
    if (!res.ok) throw new ApiError(res.status, "upload_failed");
    return (await res.json()) as { blobId: string };
  },
  turn: (token: string) => req<TurnResponse>("/turn", { token }),
  getVapid: () => req<VapidResponse>("/push/vapid"),
  subscribePush: (body: PushSubscribeRequest, token: string) =>
    req<{ ok: boolean }>("/push/subscribe", { method: "POST", token, body }),
  async downloadBlob(
    blobId: string,
    token: string,
  ): Promise<Uint8Array<ArrayBuffer>> {
    const res = await fetch(`${API_V1}/blobs/${encodeURIComponent(blobId)}`, {
      headers: { authorization: `Bearer ${token}` },
    });
    if (!res.ok) throw new ApiError(res.status, "download_failed");
    return new Uint8Array(await res.arrayBuffer());
  },
};
