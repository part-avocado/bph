import { useAuth } from "@clerk/react";
import { useCallback, useMemo } from "react";
import type { IntakeState, Project, ProjectDetail, ProjectStatus } from "../../shared/types";

export class ApiError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
  }
}

export interface ProjectSummary {
  id: string;
  title: string;
  idea: string;
  status: ProjectStatus;
  updated_at: number;
  score: number | null;
}

/**
 * Requests that are safe to share: identical calls made while one is already
 * in flight (StrictMode double effects, quick remounts) reuse its promise.
 */
const inflight = new Map<string, Promise<unknown>>();

export function useApi() {
  const { getToken } = useAuth();

  const call = useCallback(
    async <T,>(path: string, init: RequestInit = {}): Promise<T> => {
      const token = await getToken();
      const headers = new Headers(init.headers);
      if (token) headers.set("Authorization", `Bearer ${token}`);
      if (init.body && !(init.body instanceof FormData)) headers.set("content-type", "application/json");
      const res = await fetch(`/api${path}`, { ...init, headers });
      const data = (await res.json().catch(() => ({}))) as T & { error?: string };
      if (!res.ok) throw new ApiError(data.error ?? `Request failed (${res.status})`, res.status);
      return data;
    },
    [getToken],
  );

  const shared = useCallback(
    <T,>(path: string, init: RequestInit = {}): Promise<T> => {
      const key = `${init.method ?? "GET"} ${path}`;
      const existing = inflight.get(key);
      if (existing) return existing as Promise<T>;
      const p = call<T>(path, init).finally(() => inflight.delete(key));
      inflight.set(key, p);
      return p;
    },
    [call],
  );

  return useMemo(
    () => ({
      getToken,
      listProjects: () => shared<{ projects: ProjectSummary[] }>("/projects"),
      createProject: (idea: string, files: File[]) => {
        const form = new FormData();
        form.set("idea", idea);
        for (const f of files) form.append("files", f, f.name);
        return call<{ project: Project }>("/projects", { method: "POST", body: form });
      },
      getProject: (id: string) => shared<ProjectDetail>(`/projects/${id}`),
      deleteProject: (id: string) => call<{ ok: true }>(`/projects/${id}`, { method: "DELETE" }),
      // Planning is idempotent but costs a model call; never run two at once for one project.
      plan: (id: string) => shared<IntakeState>(`/projects/${id}/plan`, { method: "POST" }),
      answer: (id: string, body: { questionId: string; prompt: string; answer: string | null; replan?: boolean }) =>
        call<IntakeState>(`/projects/${id}/answers`, { method: "POST", body: JSON.stringify(body) }),
      startRun: (id: string, improve = false) =>
        call<{ runId: string }>(`/projects/${id}/runs`, { method: "POST", body: JSON.stringify({ improve }) }),
    }),
    [call, shared, getToken],
  );
}

export type Api = ReturnType<typeof useApi>;
