/**
 * Zod request-validation middleware.
 *
 * Parses `params`, `query`, and `body` against the provided schemas and stores the
 * parsed (coerced, stripped) values back on the request. Validation failures are
 * forwarded to the central error handler, which renders the error envelope.
 *
 * Note: Express 5 exposes `req.query` as a getter, so it is replaced via
 * `Object.defineProperty` rather than direct assignment.
 *
 * @param {{
 *   params?: import("zod").ZodTypeAny,
 *   query?: import("zod").ZodTypeAny,
 *   body?: import("zod").ZodTypeAny,
 * }} schemas
 */
export function validate(schemas) {
  return function validateRequest(req, _res, next) {
    try {
      if (schemas.params) {
        req.params = schemas.params.parse(req.params);
      }
      if (schemas.body) {
        req.body = schemas.body.parse(req.body);
      }
      if (schemas.query) {
        const parsedQuery = schemas.query.parse(req.query);
        Object.defineProperty(req, "query", {
          value: parsedQuery,
          writable: true,
          enumerable: true,
          configurable: true,
        });
      }
      next();
    } catch (err) {
      next(err);
    }
  };
}

export default validate;
