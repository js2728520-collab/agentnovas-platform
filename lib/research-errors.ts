export class ResearchApiError extends Error {
  readonly code: string;
  readonly status: number;
  readonly details: Record<string, unknown>;

  constructor(code: string, message: string, status: number, details: Record<string, unknown> = {}) {
    super(message);
    this.name = "ResearchApiError";
    this.code = code;
    this.status = status;
    this.details = details;
  }
}
