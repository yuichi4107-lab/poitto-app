export interface Env {
  BUCKET: R2Bucket;
  HUB: DurableObjectNamespace;
  ASSETS: Fetcher;
  COOKIE_SIGNING_KEY: string;
  ADMIN_SETUP_PASSPHRASE?: string;
  RETENTION_HOURS: string;
  MAX_FILE_BYTES?: string;
}

export type ItemKind = "file" | "text" | "link" | "image";

export interface TimelineItem {
  id: string;
  kind: ItemKind;
  createdAt: number; // epoch ms
  deviceId: string;
  deviceName: string;
  size?: number;
  filename?: string;
  contentType?: string;
  // Stored in R2 under this key when kind !== "text"
  r2Key?: string;
  // Inline for small text items
  text?: string;
}

export interface DeviceInfo {
  id: string;
  name: string;
  createdAt: number;
  lastSeenAt: number;
  revoked?: boolean;
  apiToken?: string;
}

