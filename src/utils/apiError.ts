/**
 * Custom API Error class
 * Allows throwing errors with specific HTTP status codes.
 * Example: throw new ApiError(404, "Resource not found");
 */
export class ApiError extends Error {
  constructor(public status: number, message: string) {
    super(message);
    this.name = "ApiError";
    
    // Ensure the prototype is set correctly for instanceof checks
    Object.setPrototypeOf(this, ApiError.prototype);
  }
}
