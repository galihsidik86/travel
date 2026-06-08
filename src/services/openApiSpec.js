// Stage 116 — OpenAPI 3.1 spec for /api/v1/*.
//
// Hand-written rather than reflected from code. Spec accuracy is a
// public contract; auto-derivation tools tend to lose nuance (which
// fields are nullable, what status codes the route can return) unless
// every route is annotated heavily anyway. Three endpoints → manual
// spec is the right cost/benefit.
//
// Versioning: bumped together with /v1 path changes. Partners diff
// the JSON to detect compatibility breaks.

export function buildOpenApiSpec({ baseUrl = '' } = {}) {
  return {
    openapi: '3.1.0',
    info: {
      title: 'Religio Pro Partner API',
      version: '1.0.0',
      description: 'Read-only API for partner integrations. Bearer token via S113 API keys.',
      contact: { name: 'Religio Pro', url: 'https://github.com/galihsidik86/travel' },
    },
    servers: baseUrl ? [{ url: baseUrl }] : [{ url: '/' }],
    security: [{ bearerAuth: [] }],

    components: {
      securitySchemes: {
        bearerAuth: {
          type: 'http',
          scheme: 'bearer',
          bearerFormat: 'rp_<id>.<secret>',
          description: 'API key from /admin/api-keys. Scopes enforced per endpoint.',
        },
      },
      schemas: {
        Booking: {
          type: 'object',
          properties: {
            id: { type: 'string' },
            bookingNo: { type: 'string', example: 'RP-2026-00001' },
            status: { type: 'string', enum: ['PENDING', 'BOOKED', 'DP_PAID', 'PARTIAL', 'LUNAS', 'CANCELLED', 'REFUNDED'] },
            kelas: { type: 'string' },
            paxCount: { type: 'integer' },
            totalAmountIdr: { type: 'number' },
            paidAmountIdr: { type: 'number' },
            createdAt: { type: 'string', format: 'date-time' },
            updatedAt: { type: 'string', format: 'date-time' },
            notes: { type: 'string', nullable: true },
            jemaah: {
              type: 'object', nullable: true,
              properties: {
                fullName: { type: 'string' }, phone: { type: 'string' }, email: { type: 'string', nullable: true },
                passportNo: { type: 'string', nullable: true },
                passportExpiry: { type: 'string', format: 'date-time', nullable: true },
              },
            },
            paket: {
              type: 'object', nullable: true,
              properties: {
                slug: { type: 'string' }, title: { type: 'string' },
                departureDate: { type: 'string', format: 'date-time', nullable: true },
                returnDate: { type: 'string', format: 'date-time', nullable: true },
              },
            },
            agent: {
              type: 'object', nullable: true,
              properties: { slug: { type: 'string' }, displayName: { type: 'string' } },
            },
            agentSlugCap: { type: 'string', nullable: true },
            room: {
              type: 'object', nullable: true,
              properties: { roomNo: { type: 'string' } },
            },
          },
        },
        BookingWithPayments: {
          allOf: [
            { $ref: '#/components/schemas/Booking' },
            {
              type: 'object',
              properties: {
                payments: {
                  type: 'array',
                  items: {
                    type: 'object',
                    properties: {
                      id: { type: 'string' },
                      amountIdr: { type: 'number' },
                      currency: { type: 'string' },
                      method: { type: 'string' },
                      status: { type: 'string', enum: ['PAID', 'REFUNDED'] },
                      createdAt: { type: 'string', format: 'date-time' },
                      notes: { type: 'string', nullable: true },
                    },
                  },
                },
              },
            },
          ],
        },
        Paket: {
          type: 'object',
          properties: {
            id: { type: 'string' }, slug: { type: 'string' }, title: { type: 'string' },
            departureDate: { type: 'string', format: 'date-time', nullable: true },
            returnDate: { type: 'string', format: 'date-time', nullable: true },
            durationDays: { type: 'integer' },
            kursiTotal: { type: 'integer' }, kursiTerisi: { type: 'integer' },
            airline: { type: 'string', nullable: true },
            routeFrom: { type: 'string', nullable: true },
            routeTo: { type: 'string', nullable: true },
            status: { type: 'string' },
          },
        },
        Pagination: {
          type: 'object',
          properties: {
            page: { type: 'integer' }, limit: { type: 'integer' },
            total: { type: 'integer' }, totalPages: { type: 'integer' },
            hasMore: { type: 'boolean' },
          },
        },
        Error: {
          type: 'object',
          properties: {
            error: {
              type: 'object',
              properties: { code: { type: 'string' }, message: { type: 'string' } },
            },
          },
        },
      },
      responses: {
        Unauthorized: { description: 'Invalid or missing Bearer token', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
        Forbidden:    { description: 'Token lacks required scope',     content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
        RateLimited:  { description: 'Rate limit exceeded — Retry-After set', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
        NotFound:     { description: 'Resource not found',              content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
      },
    },

    paths: {
      '/api/v1/bookings': {
        get: {
          summary: 'List bookings (paginated)',
          security: [{ bearerAuth: ['read:bookings'] }],
          parameters: [
            { name: 'page',   in: 'query', schema: { type: 'integer', minimum: 1, default: 1 } },
            { name: 'limit',  in: 'query', schema: { type: 'integer', minimum: 1, maximum: 100, default: 50 } },
            { name: 'status', in: 'query', schema: { type: 'string', enum: ['PENDING', 'BOOKED', 'DP_PAID', 'PARTIAL', 'LUNAS', 'CANCELLED', 'REFUNDED'] } },
            { name: 'from',   in: 'query', description: 'ISO-8601 date (createdAt >=)', schema: { type: 'string', format: 'date-time' } },
            { name: 'to',     in: 'query', description: 'ISO-8601 date (createdAt <=)', schema: { type: 'string', format: 'date-time' } },
          ],
          responses: {
            200: {
              description: 'Paginated list',
              content: {
                'application/json': {
                  schema: {
                    type: 'object',
                    properties: {
                      data: { type: 'array', items: { $ref: '#/components/schemas/Booking' } },
                      pagination: { $ref: '#/components/schemas/Pagination' },
                      filters: {
                        type: 'object',
                        properties: {
                          status: { type: 'string', nullable: true },
                          from: { type: 'string', nullable: true },
                          to: { type: 'string', nullable: true },
                        },
                      },
                    },
                  },
                },
              },
            },
            401: { $ref: '#/components/responses/Unauthorized' },
            403: { $ref: '#/components/responses/Forbidden' },
            429: { $ref: '#/components/responses/RateLimited' },
          },
        },
      },
      '/api/v1/bookings/{id}': {
        get: {
          summary: 'Get single booking with inline payments[]',
          security: [{ bearerAuth: ['read:bookings'] }],
          parameters: [
            { name: 'id', in: 'path', required: true, schema: { type: 'string' } },
          ],
          responses: {
            200: {
              description: 'Booking + payments',
              content: {
                'application/json': {
                  schema: {
                    type: 'object',
                    properties: { data: { $ref: '#/components/schemas/BookingWithPayments' } },
                  },
                },
              },
            },
            401: { $ref: '#/components/responses/Unauthorized' },
            403: { $ref: '#/components/responses/Forbidden' },
            404: { $ref: '#/components/responses/NotFound' },
            429: { $ref: '#/components/responses/RateLimited' },
          },
        },
      },
      '/api/v1/paket': {
        get: {
          summary: 'List ACTIVE paket',
          security: [{ bearerAuth: ['read:paket'] }],
          responses: {
            200: {
              description: 'Array of active paket',
              content: {
                'application/json': {
                  schema: {
                    type: 'object',
                    properties: {
                      data: { type: 'array', items: { $ref: '#/components/schemas/Paket' } },
                    },
                  },
                },
              },
            },
            401: { $ref: '#/components/responses/Unauthorized' },
            403: { $ref: '#/components/responses/Forbidden' },
            429: { $ref: '#/components/responses/RateLimited' },
          },
        },
      },
    },
  };
}

// Tiny Swagger-UI bootstrapper — pulls the bundle from a CDN. No npm
// dep added; the spec JSON is the actual contract, this is convenience.
export function swaggerUiHtml() {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <title>Religio Pro Partner API</title>
  <link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/swagger-ui-dist@5/swagger-ui.css">
  <style>body { margin: 0; }</style>
</head>
<body>
  <div id="ui"></div>
  <script src="https://cdn.jsdelivr.net/npm/swagger-ui-dist@5/swagger-ui-bundle.js"></script>
  <script>
    window.ui = SwaggerUIBundle({
      url: '/api/v1/openapi.json',
      dom_id: '#ui',
      deepLinking: true,
      layout: 'BaseLayout',
    });
  </script>
</body>
</html>`;
}
