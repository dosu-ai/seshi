import type { RecordsView, RowFilter, SessionDetail, SessionList } from "../types";

let token = "";

export function setToken(value: string): void {
  token = value;
}

export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

async function get<T>(path: string): Promise<T> {
  const response = await fetch(path, {
    headers: { "X-Seshi-Token": token },
    cache: "no-store",
    credentials: "omit",
  });
  if (!response.ok) {
    let message = `${response.status} ${response.statusText}`;
    try {
      const body = (await response.json()) as { message?: string };
      if (body.message) message = body.message;
    } catch {}
    throw new ApiError(response.status, message);
  }
  return (await response.json()) as T;
}

const sessionPath = (agent: string, id: string) =>
  `/api/sessions/${encodeURIComponent(agent)}/${encodeURIComponent(id)}`;

export const api = {
  list: (refresh = false) => get<SessionList>(`/api/sessions${refresh ? "?refresh=1" : ""}`),
  detail: (agent: string, id: string, fresh = false) =>
    get<SessionDetail>(`${sessionPath(agent, id)}${fresh ? "?fresh=1" : ""}`),
  records: (agent: string, id: string, offset: number, limit: number, filter: RowFilter) =>
    get<RecordsView>(
      `${sessionPath(agent, id)}/records?offset=${offset}&limit=${limit}&filter=${filter}`,
    ),
};
