import { readFileSync } from "node:fs";

const SPEC_URL = new URL("../../openapi.yaml", import.meta.url);

let cachedSpec;

/**
 * Read the OpenAPI document once and cache it for the process lifetime.
 * The file is static and shipped in the image, so a cached read is safe.
 *
 * @returns {string} the raw OpenAPI YAML
 */
export function getOpenApiSpec() {
  if (cachedSpec === undefined) {
    cachedSpec = readFileSync(SPEC_URL, "utf8");
  }
  return cachedSpec;
}

/**
 * Self-contained Swagger UI page. The UI bundle is loaded from a CDN so the API
 * gains browsable docs without adding a runtime dependency.
 *
 * @returns {string} HTML document
 */
export function getSwaggerHtml() {
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>api-stiker API docs</title>
    <link
      rel="stylesheet"
      href="https://unpkg.com/swagger-ui-dist@5/swagger-ui.css"
    />
    <style>
      body { margin: 0; }
    </style>
  </head>
  <body>
    <div id="swagger-ui"></div>
    <script src="https://unpkg.com/swagger-ui-dist@5/swagger-ui-bundle.js" crossorigin></script>
    <script>
      window.onload = () => {
        window.ui = SwaggerUIBundle({
          url: "/openapi.yaml",
          dom_id: "#swagger-ui",
          deepLinking: true,
          presets: [SwaggerUIBundle.presets.apis],
        });
      };
    </script>
  </body>
</html>
`;
}
