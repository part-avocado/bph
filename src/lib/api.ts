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

  return useMemo(
    () => ({
      getToken,
      listProjects: () => call<{ projects: ProjectSummary[] }>("/projects"),
      createProject: (idea: string, files: File[]) => {
        const form = new FormData();
        form.set("idea", idea);
        for (const f of files) form.append("files", f, f.name);
        return call<{ project: Project }>("/projects", { method: "POST", body: form });
      },
      getProject: (id: string) => call<ProjectDetail>(`/projects/${id}`),
      deleteProject: (id: string) => call<{ ok: true }>(`/projects/${id}`, { method: "DELETE" }),
      plan: (id: string) => call<IntakeState>(`/projects/${id}/plan`, { method: "POST" }),
      answer: (id: string, body: { questionId: string; prompt: string; answer: string | null; replan?: boolean }) =>
        call<IntakeState>(`/projects/${id}/answers`, { method: "POST", body: JSON.stringify(body) }),
      startRun: (id: string, improve = false) =>
        call<{ runId: string }>(`/projects/${id}/runs`, { method: "POST", body: JSON.stringify({ improve }) }),
    }),
    [call, getToken],
  );
}

export type Api = ReturnType<typeof useApi>;
