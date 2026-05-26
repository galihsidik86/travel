// Auth + RBAC tests.
//   - JWT roundtrip + tamper + expiry
//   - password hash + compare
//   - guardEscalation via createUser (SUPERADMIN cannot manage OWNER)
//   - per-role profile creation (createUser side-effect)
//   - setPassword invalidates old credentials
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import jwt from 'jsonwebtoken';

import { db, makeTag, tempUser, fakeReq } from './_helpers.js';
import { signToken, verifyToken, COOKIE_NAME, cookieOptions } from '../src/lib/jwt.js';
import { hashPassword, comparePassword } from '../src/lib/auth.js';
import { createUser, updateUser, setPassword } from '../src/services/userAdmin.js';
import { env } from '../src/env.js';

describe('JWT (pure)', () => {
  test('JWT_SECRET is set (tests require it)', () => {
    assert.ok(env.JWT_SECRET, 'JWT_SECRET must be set in .env to run auth tests');
  });

  test('sign + verify roundtrips claims', () => {
    const token = signToken({ sub: 'user-123', role: 'OWNER', email: 'a@b' });
    const decoded = verifyToken(token);
    assert.equal(decoded.sub, 'user-123');
    assert.equal(decoded.role, 'OWNER');
    assert.equal(decoded.email, 'a@b');
    assert.equal(decoded.iss, 'religio-pro', 'issuer claim set');
    assert.ok(decoded.exp > decoded.iat, 'exp after iat');
  });

  test('verify rejects tampered token (TOKEN_INVALID 401)', () => {
    const token = signToken({ sub: 'u' });
    // Flip a character in the signature segment
    const parts = token.split('.');
    parts[2] = parts[2].slice(0, -1) + (parts[2].slice(-1) === 'A' ? 'B' : 'A');
    const tampered = parts.join('.');
    assert.throws(
      () => verifyToken(tampered),
      (err) => err.status === 401 && err.code === 'TOKEN_INVALID',
    );
  });

  test('verify rejects expired token (TOKEN_EXPIRED 401)', () => {
    const token = signToken({ sub: 'u' }, { expiresIn: -1 }); // expired 1s ago
    assert.throws(
      () => verifyToken(token),
      (err) => err.status === 401 && err.code === 'TOKEN_EXPIRED',
    );
  });

  test('verify rejects wrong issuer', () => {
    // Sign with a different issuer via raw jwt.sign
    const stranger = jwt.sign({ sub: 'u' }, env.JWT_SECRET, {
      issuer: 'not-religio', expiresIn: '1h',
    });
    assert.throws(
      () => verifyToken(stranger),
      (err) => err.status === 401 && err.code === 'TOKEN_INVALID',
    );
  });

  test('cookieOptions: httpOnly + sameSite=lax + path=/', () => {
    const opts = cookieOptions();
    assert.equal(opts.httpOnly, true);
    assert.equal(opts.sameSite, 'lax');
    assert.equal(opts.path, '/');
    assert.equal(COOKIE_NAME, 'rp_session');
    assert.ok(typeof opts.maxAge === 'number' && opts.maxAge > 0);
  });
});

describe('password hash + compare', () => {
  test('hash produces non-plain output; compare validates', async () => {
    const plain = 'correct horse battery staple';
    const hash = await hashPassword(plain);
    assert.notEqual(hash, plain, 'hash differs from plain');
    assert.ok(hash.length >= 50, 'bcrypt-shaped output');
    assert.equal(await comparePassword(plain, hash), true);
    assert.equal(await comparePassword('wrong pw', hash), false);
  });

  test('same plaintext produces different hashes (salt)', async () => {
    const h1 = await hashPassword('same');
    const h2 = await hashPassword('same');
    assert.notEqual(h1, h2, 'each hash uniquely salted');
    // Both still verify
    assert.equal(await comparePassword('same', h1), true);
    assert.equal(await comparePassword('same', h2), true);
  });
});

describe('createUser — guardEscalation + per-role profile', () => {
  // Actor roles → which target roles they can create
  // OWNER         → any
  // SUPERADMIN    → any EXCEPT OWNER
  // anything else → none

  test('OWNER can create OWNER', async (t) => {
    const tag = makeTag('cu-owner-owner');
    const ownerActor = await tempUser(t, tag, { role: 'OWNER' });
    const created = await createUser({
      req: fakeReq,
      actor: { id: ownerActor.id, email: ownerActor.email, role: ownerActor.role },
      input: {
        email: `${tag}-new@example.test`, password: 'pw12345678',
        role: 'OWNER', status: 'ACTIVE', fullName: 'New Owner', phone: '+62811',
      },
    });
    t.after(() => db.user.delete({ where: { id: created.id } }));
    assert.equal(created.role, 'OWNER');
  });

  test('SUPERADMIN cannot create OWNER (ROLE_ESCALATION_BLOCKED 403)', async (t) => {
    const tag = makeTag('cu-sa-block');
    const sa = await tempUser(t, tag, { role: 'SUPERADMIN' });
    await assert.rejects(
      createUser({
        req: fakeReq,
        actor: { id: sa.id, email: sa.email, role: sa.role },
        input: {
          email: `${tag}-blocked@example.test`, password: 'pw12345678',
          role: 'OWNER', status: 'ACTIVE', fullName: 'Wannabe Owner', phone: '+62811',
        },
      }),
      (err) => err.status === 403 && err.code === 'ROLE_ESCALATION_BLOCKED',
    );
  });

  test('SUPERADMIN can create non-OWNER roles', async (t) => {
    const tag = makeTag('cu-sa-ok');
    const sa = await tempUser(t, tag, { role: 'SUPERADMIN' });
    const kasir = await createUser({
      req: fakeReq,
      actor: { id: sa.id, email: sa.email, role: sa.role },
      input: {
        email: `${tag}-k@example.test`, password: 'pw12345678',
        role: 'KASIR', status: 'ACTIVE', fullName: 'New Kasir', phone: '+62811',
      },
    });
    t.after(async () => {
      await db.staffProfile.deleteMany({ where: { userId: kasir.id } });
      await db.user.delete({ where: { id: kasir.id } });
    });
    assert.equal(kasir.role, 'KASIR');
  });

  test('MANAJER_OPS cannot create users at all (guard throws)', async (t) => {
    const tag = makeTag('cu-mo-blocked');
    const mo = await tempUser(t, tag, { role: 'MANAJER_OPS' });
    await assert.rejects(
      createUser({
        req: fakeReq,
        actor: { id: mo.id, email: mo.email, role: mo.role },
        input: {
          email: `${tag}-x@example.test`, password: 'pw12345678',
          role: 'KASIR', status: 'ACTIVE', fullName: 'Should Fail', phone: '+62811',
        },
      }),
      (err) => err.status === 403 && err.code === 'ROLE_ESCALATION_BLOCKED',
    );
  });

  test('creates correct profile type per role', async (t) => {
    const tag = makeTag('cu-profiles');
    const owner = await tempUser(t, tag, { role: 'OWNER' });
    const actor = { id: owner.id, email: owner.email, role: 'OWNER' };

    const jemaah = await createUser({
      req: fakeReq, actor,
      input: {
        email: `${tag}-jem@example.test`, password: 'pw12345678',
        role: 'JEMAAH', status: 'ACTIVE', fullName: 'J', phone: '+62811',
      },
    });
    const agent = await createUser({
      req: fakeReq, actor,
      input: {
        email: `${tag}-agen@example.test`, password: 'pw12345678',
        role: 'AGEN', status: 'ACTIVE', fullName: 'A', phone: '+62811',
        slug: `agent-${tag}`, displayName: 'A',
      },
    });
    const muthawwif = await createUser({
      req: fakeReq, actor,
      input: {
        email: `${tag}-mut@example.test`, password: 'pw12345678',
        role: 'MUTHAWWIF', status: 'ACTIVE', fullName: 'M', phone: '+62811',
      },
    });
    const kasir = await createUser({
      req: fakeReq, actor,
      input: {
        email: `${tag}-k@example.test`, password: 'pw12345678',
        role: 'KASIR', status: 'ACTIVE', fullName: 'K', phone: '+62811',
      },
    });
    t.after(async () => {
      const ids = [jemaah.id, agent.id, muthawwif.id, kasir.id];
      await db.jemaahProfile.deleteMany({ where: { userId: { in: ids } } });
      await db.agentProfile.deleteMany({ where: { userId: { in: ids } } });
      await db.crewProfile.deleteMany({ where: { userId: { in: ids } } });
      await db.staffProfile.deleteMany({ where: { userId: { in: ids } } });
      await db.user.deleteMany({ where: { id: { in: ids } } });
    });

    assert.ok(await db.jemaahProfile.findFirst({ where: { userId: jemaah.id } }), 'JEMAAH → jemaahProfile');
    assert.ok(await db.agentProfile.findFirst({ where: { userId: agent.id } }), 'AGEN → agentProfile');
    assert.ok(await db.crewProfile.findFirst({ where: { userId: muthawwif.id } }), 'MUTHAWWIF → crewProfile');
    assert.ok(await db.staffProfile.findFirst({ where: { userId: kasir.id } }), 'KASIR → staffProfile');
  });

  test('email collision → EMAIL_TAKEN', async (t) => {
    const tag = makeTag('cu-dupe');
    const owner = await tempUser(t, tag, { role: 'OWNER' });
    const actor = { id: owner.id, email: owner.email, role: 'OWNER' };
    const first = await createUser({
      req: fakeReq, actor,
      input: {
        email: `${tag}-shared@example.test`, password: 'pw12345678',
        role: 'KASIR', status: 'ACTIVE', fullName: 'First', phone: '+62811',
      },
    });
    t.after(async () => {
      await db.staffProfile.deleteMany({ where: { userId: first.id } });
      await db.user.delete({ where: { id: first.id } });
    });

    await assert.rejects(
      createUser({
        req: fakeReq, actor,
        input: {
          email: `${tag}-shared@example.test`, password: 'pw87654321',
          role: 'KASIR', status: 'ACTIVE', fullName: 'Second', phone: '+62811',
        },
      }),
      (err) => err.status === 409 && err.code === 'EMAIL_TAKEN',
    );
  });
});

describe('updateUser — anti-escalation works in both directions', () => {
  test('SUPERADMIN cannot demote OWNER (source role guarded)', async (t) => {
    const tag = makeTag('uu-source');
    const owner = await tempUser(t, tag, { role: 'OWNER' });
    const targetOwner = await tempUser(t, `${tag}-target`, { role: 'OWNER' });
    const sa = await tempUser(t, `${tag}-sa`, { role: 'SUPERADMIN' });

    // SUPERADMIN tries to flip targetOwner OWNER → KASIR. Source role OWNER
    // hits guardEscalation first.
    await assert.rejects(
      updateUser({
        req: fakeReq,
        actor: { id: sa.id, email: sa.email, role: sa.role },
        userId: targetOwner.id,
        input: {
          email: targetOwner.email, role: 'KASIR', status: 'ACTIVE',
          fullName: targetOwner.fullName, phone: targetOwner.phone,
        },
      }),
      (err) => err.code === 'ROLE_ESCALATION_BLOCKED',
    );
    // sanity: owner untouched
    const after = await db.user.findUnique({ where: { id: targetOwner.id } });
    assert.equal(after.role, 'OWNER');
  });

  test('SUPERADMIN cannot promote KASIR → OWNER (target role guarded)', async (t) => {
    const tag = makeTag('uu-target');
    const sa = await tempUser(t, tag, { role: 'SUPERADMIN' });
    const kasir = await tempUser(t, `${tag}-k`, { role: 'KASIR' });

    await assert.rejects(
      updateUser({
        req: fakeReq,
        actor: { id: sa.id, email: sa.email, role: sa.role },
        userId: kasir.id,
        input: {
          email: kasir.email, role: 'OWNER', status: 'ACTIVE',
          fullName: kasir.fullName, phone: kasir.phone,
        },
      }),
      (err) => err.code === 'ROLE_ESCALATION_BLOCKED',
    );
  });
});

describe('setPassword', () => {
  test('rotates hash; old password no longer verifies', async (t) => {
    const tag = makeTag('setpw');
    const owner = await tempUser(t, tag, { role: 'OWNER' });
    const target = await tempUser(t, `${tag}-t`, { role: 'KASIR' });

    const before = await db.user.findUnique({ where: { id: target.id }, select: { passwordHash: true } });
    // tempUser uses 'test12345' — verify that works initially
    assert.equal(await comparePassword('test12345', before.passwordHash), true);

    await setPassword({
      req: fakeReq,
      actor: { id: owner.id, email: owner.email, role: owner.role },
      userId: target.id,
      password: 'brand-new-strong-pw',
    });

    const after = await db.user.findUnique({ where: { id: target.id }, select: { passwordHash: true } });
    assert.notEqual(after.passwordHash, before.passwordHash, 'hash changed');
    assert.equal(await comparePassword('test12345', after.passwordHash), false, 'old pw no longer valid');
    assert.equal(await comparePassword('brand-new-strong-pw', after.passwordHash), true, 'new pw valid');
  });
});
