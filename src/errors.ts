export type ErrorCode =
  | 'unauthorized'
  | 'too_many_requests'
  | 'invalid_request'
  | 'not_found'
  | 'repeating_not_supported'
  | 'things_unavailable'
  | 'setup_required'
  | 'write_not_confirmed'
  | 'internal'

export class ApiError extends Error {
  readonly status: number
  readonly code: ErrorCode

  constructor(status: number, code: ErrorCode, message: string) {
    super(message)
    this.status = status
    this.code = code
  }
}

export const invalid = (message: string) => new ApiError(400, 'invalid_request', message)
export const notFound = (message: string) => new ApiError(404, 'not_found', message)
