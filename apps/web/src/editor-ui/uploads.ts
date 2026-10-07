import type { UploadStage } from "../api/client";

/** Client-side view of one file moving through hash → upload → server verification. */
export interface UploadItem {
  key: string;
  name: string;
  stage: "hashing" | UploadStage;
  state: "active" | "done" | "error";
  message?: string;
}

const progress: Record<UploadItem["stage"], number> = {
  hashing: 0.1,
  reserved: 0.35,
  uploaded: 0.7,
  verifying: 0.85,
  completed: 1,
  rejected: 1,
};

const labels: Record<UploadItem["stage"], string> = {
  hashing: "Computing SHA-256…",
  reserved: "Uploading…",
  uploaded: "Finalizing upload…",
  verifying: "Verifying checksum and format…",
  completed: "Verified",
  rejected: "Rejected",
};

export function uploadProgress(item: UploadItem): number {
  return progress[item.stage];
}

export function uploadStageLabel(item: UploadItem): string {
  return labels[item.stage];
}

export function updateUpload(
  items: UploadItem[],
  key: string,
  patch: Partial<Omit<UploadItem, "key">>,
): UploadItem[] {
  return items.map((item) => (item.key === key ? { ...item, ...patch } : item));
}
