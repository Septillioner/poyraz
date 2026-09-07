export type ActivityStatus = 'running' | 'success' | 'error' | 'blocked';

export interface ToolActivityView {
  toolCallId: string;
  toolName: string;
  label: string;
  detail?: string;
  status: ActivityStatus;
  args?: Record<string, unknown>;
  resultPreview?: string;
  resultRaw?: string;
  resultMeta?: Record<string, unknown>;
  errorCode?: string;
  errorMessage?: string;
}
