// Stage 114 — partner-facing read API. Versioned at /api/v1/* so future
// breaking changes can ship under /v2 without disturbing existing
// integrations. All routes gated by S113's API key middleware.
//
// Output shape mirrors the CSV bundle (S106) for consistency: same
// field names, same money semantics. Pagination is cursor-friendly via
// `?page=` + `limit=50` (cap 100) — partner doesn't have to deal with
// offset pitfalls but can still walk the full set.

import { Router } from 'express';
import { asyncHandler } from '../lib/asyncHandler.js';
import { requireApiScope, apiKeyRateLimit } from '../services/apiKeys.js';
import { db } from '../lib/db.js';

const router = Router();

// Stage 116 — OpenAPI discovery surface. No auth (the spec itself is
// public; partners need it to know how to authenticate).
router.get(
  '/openapi.json',
  asyncHandler(async (req, res) => {
    const { buildOpenApiSpec } = await import('../services/openApiSpec.js');
    const { env } = await import('../env.js');
    const proto = req.headers['x-forwarded-proto'] || req.protocol;
    const host = req.headers['x-forwarded-host'] || req.headers.host;
    const baseUrl = env.PUBLIC_BASE_URL || `${proto}://${host}`;
    res.json(buildOpenApiSpec({ baseUrl }));
  }),
);

router.get(
  '/docs',
  asyncHandler(async (_req, res) => {
    const { swaggerUiHtml } = await import('../services/openApiSpec.js');
    res.type('text/html').send(swaggerUiHtml());
  }),
);

const MAX_LIMIT = 100;
const DEFAULT_LIMIT = 50;

const BOOKING_STATUSES = ['PENDING', 'BOOKED', 'DP_PAID', 'PARTIAL', 'LUNAS', 'CANCELLED', 'REFUNDED'];

// GET /api/v1/bookings?from=&to=&status=&page=&limit=
router.get(
  '/bookings',
  requireApiScope('read:bookings'),
  apiKeyRateLimit,
  asyncHandler(async (req, res) => {
    const page = Math.max(1, parseInt(req.query.page, 10) || 1);
    const limit = Math.min(MAX_LIMIT, Math.max(1, parseInt(req.query.limit, 10) || DEFAULT_LIMIT));
    const status = (req.query.status || '').toString();
    const from = req.query.from ? new Date(req.query.from) : null;
    const to = req.query.to ? new Date(req.query.to) : null;

    const where = {};
    if (status && BOOKING_STATUSES.includes(status)) where.status = status;
    if (from && !Number.isNaN(from.getTime())) where.createdAt = { ...(where.createdAt || {}), gte: from };
    if (to && !Number.isNaN(to.getTime())) where.createdAt = { ...(where.createdAt || {}), lte: to };

    const [total, rows] = await Promise.all([
      db.booking.count({ where }),
      db.booking.findMany({
        where,
        skip: (page - 1) * limit,
        take: limit,
        orderBy: { createdAt: 'desc' },
        select: {
          id: true, bookingNo: true, status: true, kelas: true, paxCount: true,
          totalAmount: true, paidAmount: true,
          createdAt: true, updatedAt: true,
          notes: true,
          paket: { select: { slug: true, title: true, departureDate: true, returnDate: true } },
          jemaah: { select: { fullName: true, phone: true, email: true, passportNo: true, passportExpiry: true } },
          agent: { select: { slug: true, displayName: true } },
          agentSlugCap: true,
          room: { select: { roomNo: true } },
        },
      }),
    ]);

    const totalPages = Math.max(1, Math.ceil(total / limit));
    const data = rows.map((b) => ({
      id: b.id,
      bookingNo: b.bookingNo,
      status: b.status,
      kelas: b.kelas,
      paxCount: b.paxCount,
      totalAmountIdr: Number(b.totalAmount?.toString?.() ?? b.totalAmount) || 0,
      paidAmountIdr: Number(b.paidAmount?.toString?.() ?? b.paidAmount) || 0,
      createdAt: b.createdAt.toISOString(),
      updatedAt: b.updatedAt.toISOString(),
      notes: b.notes || null,
      jemaah: b.jemaah ? {
        fullName: b.jemaah.fullName,
        phone: b.jemaah.phone,
        email: b.jemaah.email,
        passportNo: b.jemaah.passportNo,
        passportExpiry: b.jemaah.passportExpiry ? b.jemaah.passportExpiry.toISOString() : null,
      } : null,
      paket: b.paket ? {
        slug: b.paket.slug,
        title: b.paket.title,
        departureDate: b.paket.departureDate ? b.paket.departureDate.toISOString() : null,
        returnDate: b.paket.returnDate ? b.paket.returnDate.toISOString() : null,
      } : null,
      agent: b.agent ? { slug: b.agent.slug, displayName: b.agent.displayName } : null,
      agentSlugCap: b.agentSlugCap,
      room: b.room ? { roomNo: b.room.roomNo } : null,
    }));

    res.json({
      data,
      pagination: { page, limit, total, totalPages, hasMore: page < totalPages },
      filters: { status: status || null, from: req.query.from || null, to: req.query.to || null },
    });
  }),
);

// GET /api/v1/bookings/:id — single booking detail, same shape as list row
// plus payments[] inline (lightest payload partners need beyond the list).
router.get(
  '/bookings/:id',
  requireApiScope('read:bookings'),
  apiKeyRateLimit,
  asyncHandler(async (req, res) => {
    const b = await db.booking.findUnique({
      where: { id: req.params.id },
      select: {
        id: true, bookingNo: true, status: true, kelas: true, paxCount: true,
        totalAmount: true, paidAmount: true,
        createdAt: true, updatedAt: true, notes: true,
        paket: { select: { slug: true, title: true, departureDate: true, returnDate: true } },
        jemaah: { select: { fullName: true, phone: true, email: true, passportNo: true, passportExpiry: true } },
        agent: { select: { slug: true, displayName: true } },
        agentSlugCap: true,
        room: { select: { roomNo: true } },
        payments: {
          orderBy: { createdAt: 'asc' },
          select: { id: true, amount: true, currency: true, method: true, status: true, createdAt: true, notes: true },
        },
      },
    });
    if (!b) return res.status(404).json({ error: { code: 'BOOKING_NOT_FOUND', message: 'Not found' } });
    res.json({
      data: {
        id: b.id, bookingNo: b.bookingNo, status: b.status, kelas: b.kelas, paxCount: b.paxCount,
        totalAmountIdr: Number(b.totalAmount?.toString?.() ?? b.totalAmount) || 0,
        paidAmountIdr: Number(b.paidAmount?.toString?.() ?? b.paidAmount) || 0,
        createdAt: b.createdAt.toISOString(),
        updatedAt: b.updatedAt.toISOString(),
        notes: b.notes || null,
        jemaah: b.jemaah ? {
          fullName: b.jemaah.fullName, phone: b.jemaah.phone, email: b.jemaah.email,
          passportNo: b.jemaah.passportNo,
          passportExpiry: b.jemaah.passportExpiry ? b.jemaah.passportExpiry.toISOString() : null,
        } : null,
        paket: b.paket ? {
          slug: b.paket.slug, title: b.paket.title,
          departureDate: b.paket.departureDate ? b.paket.departureDate.toISOString() : null,
          returnDate: b.paket.returnDate ? b.paket.returnDate.toISOString() : null,
        } : null,
        agent: b.agent ? { slug: b.agent.slug, displayName: b.agent.displayName } : null,
        agentSlugCap: b.agentSlugCap,
        room: b.room ? { roomNo: b.room.roomNo } : null,
        payments: b.payments.map((p) => ({
          id: p.id,
          amountIdr: Number(p.amount?.toString?.() ?? p.amount) || 0,
          currency: p.currency,
          method: p.method,
          status: p.status,
          createdAt: p.createdAt.toISOString(),
          notes: p.notes || null,
        })),
      },
    });
  }),
);

// GET /api/v1/paket — list ACTIVE paket (lightweight enumeration for
// partner integrations that need to map bookings to paket names).
router.get(
  '/paket',
  requireApiScope('read:paket'),
  apiKeyRateLimit,
  asyncHandler(async (_req, res) => {
    const rows = await db.paket.findMany({
      where: { deletedAt: null, status: 'ACTIVE' },
      orderBy: { departureDate: 'asc' },
      select: {
        id: true, slug: true, title: true,
        departureDate: true, returnDate: true, durationDays: true,
        kursiTotal: true, kursiTerisi: true,
        airline: true, routeFrom: true, routeTo: true,
        status: true,
      },
    });
    res.json({
      data: rows.map((p) => ({
        id: p.id, slug: p.slug, title: p.title,
        departureDate: p.departureDate ? p.departureDate.toISOString() : null,
        returnDate: p.returnDate ? p.returnDate.toISOString() : null,
        durationDays: p.durationDays,
        kursiTotal: p.kursiTotal, kursiTerisi: p.kursiTerisi,
        airline: p.airline, routeFrom: p.routeFrom, routeTo: p.routeTo,
        status: p.status,
      })),
    });
  }),
);

// Stage 120 — partner audit log read. Lets partner CRMs surface
// "who changed what" inside their own UI without raw DB access.
//
// Required: ?entity=<Booking|Payment|...>&entityId=<id>
//   Entity is the AuditLog.entity string (Prisma model name basically).
//   Filters scoped to one entity/id to keep payloads bounded — bulk
//   audit feeds are a future-stage concern.
//
// Pagination same shape as /bookings (page + limit, cap 100).
router.get(
  '/audit',
  requireApiScope('read:audit'),
  apiKeyRateLimit,
  asyncHandler(async (req, res) => {
    const entity = (req.query.entity || '').toString();
    const entityId = (req.query.entityId || '').toString();
    if (!entity || !entityId) {
      return res.status(400).json({
        error: { code: 'BAD_PARAMS', message: 'entity and entityId query params required' },
      });
    }
    const page = Math.max(1, parseInt(req.query.page, 10) || 1);
    const limit = Math.min(MAX_LIMIT, Math.max(1, parseInt(req.query.limit, 10) || DEFAULT_LIMIT));

    const where = { entity, entityId };
    const [total, rows] = await Promise.all([
      db.auditLog.count({ where }),
      db.auditLog.findMany({
        where,
        skip: (page - 1) * limit,
        take: limit,
        orderBy: { createdAt: 'desc' },
        select: {
          id: true, action: true,
          actorEmail: true, actorRole: true,
          before: true, after: true,
          ip: true, createdAt: true,
        },
      }),
    ]);

    const totalPages = Math.max(1, Math.ceil(total / limit));
    res.json({
      data: rows.map((r) => ({
        id: r.id,
        action: r.action,
        actorEmail: r.actorEmail,
        actorRole: r.actorRole,
        before: r.before ?? null,
        after: r.after ?? null,
        ip: r.ip || null,
        createdAt: r.createdAt.toISOString(),
      })),
      pagination: { page, limit, total, totalPages, hasMore: page < totalPages },
      filters: { entity, entityId },
    });
  }),
);

export default router;
