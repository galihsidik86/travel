// Wrap async route/middleware so rejections forward to Express error handler.
// Required on Express 4 (Express 5 handles natively).
export const asyncHandler = (fn) => (req, res, next) => {
  Promise.resolve(fn(req, res, next)).catch(next);
};
