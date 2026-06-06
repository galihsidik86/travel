// Stage 25 — turn raw AuditLog rows into friendly activity-feed entries.
//
// Each audit row carries `entity` + `action` + a JSON `after` blob (and
// sometimes `before`). The shape inside `after` varies by entity (Booking
// gets bookingNo, Payment gets amount, etc.). This formatter centralises
// the per-entity prose + deep-link logic so views never have to peek
// inside JSON or do their own conditional formatting.
//
// Output shape:
//   {
//     id, createdAt, actorEmail, actorRole, entity, action,
//     sentence:  'Booking RP-2026-00012 dibatalkan',
//     url:       '/admin/bookings/<id>' | null,
//     badge:     'CANCEL' | 'PAYMENT' | 'LOGIN' | 'CREATE' | 'STATUS' | 'INCIDENT' | …
//     amountIdr: 5000000 | null
//   }

const IDR = (n) => {
  const x = Number(n);
  if (!Number.isFinite(x)) return null;
  return Math.round(x);
};

const fmtRp = (n) => 'Rp ' + (Math.round(Number(n) || 0)).toLocaleString('id-ID');

// Pull a value out of the after blob (or before for deletions). Defensive —
// after is sometimes null, sometimes an array, sometimes shaped differently
// than expected when older code wrote a different schema.
function pick(after, ...keys) {
  if (!after || typeof after !== 'object' || Array.isArray(after)) return null;
  for (const k of keys) {
    if (after[k] != null) return after[k];
  }
  return null;
}

export function formatAuditEntry(row) {
  const a = row.after || {};
  const b = row.before || {};
  const shortId = row.entityId ? row.entityId.slice(-6) : '';
  let sentence = `${row.action.toLowerCase()} ${row.entity}`;
  let url = null;
  let badge = row.action;
  let amountIdr = null;

  switch (row.entity) {
    case 'Booking': {
      url = `/admin/bookings/${row.entityId}`;
      const bn = pick(a, 'bookingNo') || pick(b, 'bookingNo') || shortId;
      if (row.action === 'CREATE') {
        const adminCreated = pick(a, 'adminCreated');
        sentence = adminCreated
          ? `Walk-in booking ${bn} dibuat`
          : `Booking baru ${bn}`;
        badge = 'CREATE';
      } else if (row.action === 'STATUS_CHANGE' || row.action === 'UPDATE') {
        if (pick(a, 'merged')) {
          sentence = `Booking ${bn} di-klaim jemaah · profil di-merge`;
          badge = 'CLAIM';
        } else if (pick(a, 'transfer')) {
          sentence = `Booking ${bn} di-transfer ke agen baru`;
          badge = 'TRANSFER';
        } else if (pick(a, 'status') === 'CANCELLED') {
          sentence = `Booking ${bn} dibatalkan`;
          badge = 'CANCEL';
        } else if (pick(a, 'status') === 'REFUNDED') {
          sentence = `Booking ${bn} refund penuh`;
          badge = 'REFUND';
        } else if (pick(a, 'status')) {
          sentence = `Booking ${bn} → ${pick(a, 'status')}`;
          badge = 'STATUS';
        } else {
          sentence = `Booking ${bn} diperbarui`;
          badge = 'UPDATE';
        }
      } else {
        sentence = `Booking ${bn}: ${row.action.toLowerCase()}`;
      }
      break;
    }

    case 'Payment':
    case 'KomisiPayout': {
      // Payment audit comes through as action PAYMENT_RECEIVED on Booking
      // in the existing recordPayment path; this case catches direct
      // Payment-entity rows + payouts.
      const amt = pick(a, 'amount') || pick(a, 'paidAmount');
      amountIdr = IDR(amt);
      const ref = pick(a, 'payoutNo') || pick(a, 'gatewayRef') || shortId;
      if (row.entity === 'KomisiPayout') {
        sentence = `Payout ${ref} ${amt ? '· ' + fmtRp(amt) : ''}`.trim();
        url = `/admin/payouts/${row.entityId}`;
        badge = 'PAYOUT';
      } else {
        sentence = `Pembayaran ${amt ? fmtRp(amt) : ''} ${ref ? '· ref ' + ref : ''}`.trim();
        badge = 'PAYMENT';
      }
      break;
    }

    case 'User': {
      if (row.action === 'LOGIN') {
        sentence = `Login ${row.actorEmail || '-'}`;
        badge = 'LOGIN';
      } else if (row.action === 'LOGOUT') {
        sentence = `Logout ${row.actorEmail || '-'}`;
        badge = 'LOGOUT';
      } else if (row.action === 'CREATE') {
        sentence = `User baru ${pick(a, 'email') || shortId} · role ${pick(a, 'role') || '?'}`;
        url = `/admin/users/${row.entityId}/edit`;
        badge = 'CREATE';
      } else if (row.action === 'UPDATE') {
        sentence = `User ${pick(a, 'email') || pick(b, 'email') || shortId} diperbarui`;
        url = `/admin/users/${row.entityId}/edit`;
      } else if (row.action === 'PASSWORD_CHANGE') {
        sentence = `Password user ${shortId} diubah`;
        badge = 'PWD';
      }
      break;
    }

    case 'Incident': {
      url = `/admin/incidents/${row.entityId}`;
      const type = pick(a, 'type') || pick(b, 'type') || 'incident';
      const status = pick(a, 'status');
      if (row.action === 'CREATE') {
        sentence = `Crew lapor ${type}`;
        badge = type === 'SOS' ? 'SOS' : 'INCIDENT';
      } else if (status === 'ACKED') {
        sentence = `Incident di-ack`;
        badge = 'ACK';
      } else if (status === 'RESOLVED') {
        sentence = `Incident di-resolve`;
        badge = 'RESOLVE';
      } else {
        sentence = `Incident ${type}: ${row.action.toLowerCase()}`;
      }
      break;
    }

    case 'JemaahDocument': {
      url = `/admin/jemaah/${pick(a, 'jemaahId') || pick(b, 'jemaahId') || ''}/edit`;
      const t = pick(a, 'type') || pick(b, 'type') || 'doc';
      const s = pick(a, 'status');
      if (pick(a, 'autoExpired')) {
        sentence = `Dokumen ${t} expired (auto-sweep)`;
        badge = 'EXPIRE';
      } else if (s === 'VERIFIED') {
        sentence = `Dokumen ${t} di-verify`;
        badge = 'VERIFY';
      } else if (pick(a, 'fileUploaded')) {
        sentence = `Jemaah upload ${t}`;
        badge = 'UPLOAD';
      } else {
        sentence = `Dokumen ${t}: ${row.action.toLowerCase()}`;
      }
      break;
    }

    case 'Komisi': {
      const amt = pick(a, 'amount');
      amountIdr = IDR(amt);
      sentence = `Komisi ${amt ? fmtRp(amt) + ' ' : ''}${pick(a, 'status') || row.action.toLowerCase()}`.trim();
      badge = 'KOMISI';
      break;
    }

    case 'Paket': {
      const slug = pick(a, 'slug') || pick(b, 'slug') || shortId;
      url = `/admin/paket/${slug}/edit`;
      if (pick(a, 'cloned')) {
        sentence = `Paket di-clone dari ${pick(a, 'clonedFromSlug')}`;
        badge = 'CLONE';
      } else if (row.action === 'CREATE') {
        sentence = `Paket baru ${slug}`;
        badge = 'CREATE';
      } else if (row.action === 'DELETE') {
        sentence = `Paket ${slug} di-archive`;
        badge = 'ARCHIVE';
      } else {
        sentence = `Paket ${slug} diperbarui`;
        badge = 'UPDATE';
      }
      break;
    }

    case 'AgentPaketKomisi': {
      const rate = pick(a, 'rate');
      const slug = pick(a, 'paketSlug') || pick(a, 'agentSlug');
      if (row.action === 'DELETE') {
        sentence = `Override komisi ${slug || ''} dihapus`;
        badge = 'DEL';
      } else {
        sentence = `Override komisi ${slug || ''} → ${rate != null ? (rate * 100).toFixed(1) + '%' : 'set'}`;
        badge = 'KOMISI';
      }
      break;
    }

    case 'Retention': {
      sentence = `Sweep retention dijalankan`;
      badge = 'PRUNE';
      break;
    }

    case 'Notification':
    case 'PaymentIntent':
    case 'AttendanceMark':
    default: {
      sentence = `${row.entity} ${row.action.toLowerCase()}`;
    }
  }

  return {
    id: row.id,
    createdAt: row.createdAt,
    actorEmail: row.actorEmail,
    actorRole: row.actorRole,
    entity: row.entity,
    action: row.action,
    sentence,
    url,
    badge,
    amountIdr,
  };
}

export function formatRecentActivity(rows) {
  return rows.map(formatAuditEntry);
}
