export const ErrorCodes = {
  WRONG_GOOGLE_ACCOUNT: 'WRONG_GOOGLE_ACCOUNT',
  NOT_LOGGED_IN: 'NOT_LOGGED_IN',
  FLOW_PAGE_NOT_FOUND: 'FLOW_PAGE_NOT_FOUND',
  MODEL_NOT_AVAILABLE: 'MODEL_NOT_AVAILABLE',
  RATIO_NOT_AVAILABLE: 'RATIO_NOT_AVAILABLE',
  GENERATION_BUTTON_DISABLED: 'GENERATION_BUTTON_DISABLED',
  GENERATION_TIMEOUT: 'GENERATION_TIMEOUT',
  DOWNLOAD_FAILED: 'DOWNLOAD_FAILED',
  MANUAL_VERIFICATION_REQUIRED: 'MANUAL_VERIFICATION_REQUIRED',
  GOOGLE_LIMIT_REACHED: 'GOOGLE_LIMIT_REACHED',
  UNKNOWN_UI_CHANGE: 'UNKNOWN_UI_CHANGE',
  PLAYWRIGHT_ERROR: 'PLAYWRIGHT_ERROR',
  BROWSER_NOT_CONNECTED: 'BROWSER_NOT_CONNECTED',
  JOB_IN_PROGRESS: 'JOB_IN_PROGRESS',
  INVALID_PARAMS: 'INVALID_PARAMS',
};

export class FlowError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'FlowError';
    this.code = code;
    this.details = details;
  }

  toJSON() {
    return {
      error: this.code,
      message: this.message,
      details: this.details,
    };
  }
}

export function createError(code, message, details = {}) {
  return new FlowError(code, message, details);
}
