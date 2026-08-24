import type { AnalysisJobState, ExampleVideo } from "../domain/analysisTypes";

async function parseJsonResponse<T>(response: Response): Promise<T> {
  if (!response.ok) {
    const body = (await response.json().catch(() => ({ detail: "Request failed" }))) as {
      detail?: string;
    };
    throw new Error(body.detail ?? `Request failed (${response.status})`);
  }
  return (await response.json()) as T;
}

export async function fetchExampleVideos(signal?: AbortSignal): Promise<ExampleVideo[]> {
  return parseJsonResponse<ExampleVideo[]>(await fetch("/api/examples", { signal }));
}

export async function startUploadedVideoAnalysis(file: File): Promise<string> {
  const body = new FormData();
  body.append("file", file);
  const result = await parseJsonResponse<{ job_id: string }>(
    await fetch("/api/jobs", { method: "POST", body }),
  );
  return result.job_id;
}

export async function startExampleVideoAnalysis(exampleId: string): Promise<string> {
  const result = await parseJsonResponse<{ job_id: string }>(
    await fetch(`/api/examples/${encodeURIComponent(exampleId)}/jobs`, { method: "POST" }),
  );
  return result.job_id;
}

export async function fetchAnalysisJob(jobId: string, signal?: AbortSignal): Promise<AnalysisJobState> {
  return parseJsonResponse<AnalysisJobState>(await fetch(`/api/jobs/${jobId}`, { signal }));
}

export async function cancelAnalysisJob(jobId: string): Promise<AnalysisJobState> {
  return parseJsonResponse<AnalysisJobState>(
    await fetch(`/api/jobs/${encodeURIComponent(jobId)}`, { method: "DELETE" }),
  );
}
