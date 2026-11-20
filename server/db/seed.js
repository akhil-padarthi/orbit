import fs from 'node:fs';
import { pathToFileURL } from 'node:url';
import { config } from '../config.js';
import { openDatabase, closeDatabase, one, all, run, tx, newId } from './database.js';
import { TENANTS, PERIODS, DEMO_PASSWORD, ROLE_MAP, fullName } from './fixtures.js';
import { hashPassword } from '../lib/password.js';
import { zonedToUtc, localDate, addDays, weekday, minutes } from '../lib/time.js';
import { offsetCoordinate, distanceMeters } from '../lib/geo.js';
import { ensureSectionConversation } from '../modules/messages.js';

/** Small deterministic PRNG so demo data looks the same on every seed. */
function prng(seed) {
  let s = seed >>> 0;
  return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 2 ** 32);
}

export function isSeeded() {
  return Boolean(one('SELECT id FROM tenants LIMIT 1'));
}

export async function seedDatabase({ now = new Date() } = {}) {
  const passwordHash = await hashPassword(DEMO_PASSWORD); // demo accounts share one password
  const nowIso = now.toISOString();
  const rand = prng(42);

  tx(() => {
    for (const t of TENANTS) {
      const tenantId = newId();
      run('INSERT INTO tenants (id, slug, name, timezone, created_at) VALUES (?, ?, ?, ?, ?)', tenantId, t.slug, t.name, t.timezone, nowIso);
      const campusId = newId();
      const c = t.campus;
      run(
        `INSERT INTO campuses (id, tenant_id, name, address, latitude, longitude, radius_m, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        campusId, tenantId, c.name, c.address, c.latitude, c.longitude, c.radius_m, nowIso,
      );

      // Users (only the ones that are part of the initial seed; others arrive via SIS sync).
      const userIds = {};
      for (const u of t.sis.users.filter((u) => u.seed !== false)) {
        const id = newId();
        userIds[u.sourcedId] = id;
        run(
          `INSERT INTO users (id, tenant_id, email, name, role, password_hash, status, grade_level, external_id, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, 'active', ?, ?, ?, ?)`,
          id, tenantId, u.email, fullName(u), ROLE_MAP[u.role], passwordHash, u.grade ?? null, u.sourcedId, nowIso, nowIso,
        );
      }
      for (const u of t.sis.users.filter((u) => u.seed !== false && u.agents)) {
        for (const parent of u.agents) {
          if (userIds[parent]) {
            run('INSERT INTO guardianships (tenant_id, parent_id, student_id) VALUES (?, ?, ?)', tenantId, userIds[parent], userIds[u.sourcedId]);
          }
        }
      }

      // Sections: SIS classes + locally-created flex blocks.
      const sections = [];
      for (const cls of t.sis.classes.filter((c) => c.seed !== false)) {
        const id = newId();
        run(
          `INSERT INTO sections (id, tenant_id, campus_id, teacher_id, name, course_code, room, kind, external_id, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, 'class', ?, ?)`,
          id, tenantId, campusId, userIds[cls.teacher], cls.title, cls.classCode, cls.location, cls.sourcedId, nowIso,
        );
        for (const s of cls.students) {
          if (userIds[s]) run(`INSERT INTO enrollments (tenant_id, section_id, student_id, source, created_at) VALUES (?, ?, ?, 'sis', ?)`, tenantId, id, userIds[s], nowIso);
        }
        sections.push({ id, period: cls.period, teacherId: userIds[cls.teacher], sourcedId: cls.sourcedId, name: cls.title });
      }
      for (const f of t.flex) {
        const id = newId();
        run(
          `INSERT INTO sections (id, tenant_id, campus_id, teacher_id, name, course_code, room, kind, capacity, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, 'flex', ?, ?)`,
          id, tenantId, campusId, userIds[f.teacher], f.name, f.courseCode, f.room, f.capacity, nowIso,
        );
        for (const s of f.students) {
          run(`INSERT INTO enrollments (tenant_id, section_id, student_id, source, created_at) VALUES (?, ?, ?, 'manual', ?)`, tenantId, id, userIds[s], nowIso);
        }
        sections.push({ id, period: 'flex', teacherId: userIds[f.teacher], name: f.name });
      }

      // Sessions: every weekday from two weeks ago to two weeks ahead. Flex blocks run Tue/Thu.
      const today = localDate(now, t.timezone);
      for (let offset = -14; offset <= 14; offset++) {
        const date = addDays(today, offset);
        const dow = weekday(date);
        if (dow === 0 || dow === 6) continue;
        for (const s of sections) {
          if (s.period === 'flex' && dow !== 2 && dow !== 4) continue;
          const [start, end] = PERIODS[s.period];
          const startsAt = zonedToUtc(date, start, t.timezone).toISOString();
          const endsAt = zonedToUtc(date, end, t.timezone).toISOString();
          insertSession(tenantId, s.id, startsAt, endsAt, endsAt <= nowIso ? 'finalized' : 'scheduled', nowIso);
        }
      }

      // A "live" session happening right now for the first class, so check-in can be demoed any time.
      const live = sections[0];
      const liveStart = new Date(Math.floor((now.getTime() - minutes(5)) / 60000) * 60000).toISOString();
      const liveEnd = new Date(new Date(liveStart).getTime() + minutes(60)).toISOString();
      run(`DELETE FROM sessions WHERE tenant_id = ? AND starts_at < ? AND ends_at > ?`, tenantId, liveEnd, liveStart);
      const liveSessionId = insertSession(tenantId, live.id, liveStart, liveEnd, 'scheduled', nowIso);

      // Attendance history for finalized sessions.
      const finalized = all(`SELECT id, section_id, starts_at FROM sessions WHERE tenant_id = ? AND status = 'finalized'`, tenantId);
      for (const sess of finalized) {
        const roster = all('SELECT student_id FROM enrollments WHERE section_id = ?', sess.section_id);
        for (const { student_id } of roster) {
          const r = rand();
          const status = r < 0.86 ? 'present' : r < 0.92 ? 'late' : r < 0.98 ? 'absent' : 'excused';
          const start = new Date(sess.starts_at).getTime();
          const geo = status === 'present' || status === 'late';
          const checkIn = geo ? new Date(start + (status === 'late' ? minutes(6 + Math.floor(rand() * 10)) : -minutes(Math.floor(rand() * 8)))).toISOString() : null;
          const pos = geo ? offsetCoordinate(c.latitude, c.longitude, (rand() - 0.5) * 120, (rand() - 0.5) * 120) : null;
          run(
            `INSERT INTO attendance_records (id, tenant_id, session_id, student_id, status, method, checked_in_at, latitude, longitude, accuracy_m, distance_m, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            newId(), tenantId, sess.id, student_id, status, geo ? 'geo' : status === 'excused' ? 'request' : 'system', checkIn,
            pos?.latitude ?? null, pos?.longitude ?? null, geo ? 12 : null,
            geo ? Math.round(distanceMeters(pos.latitude, pos.longitude, c.latitude, c.longitude)) : null, nowIso,
          );
        }
        run('UPDATE sessions SET finalized_at = ends_at WHERE id = ?', sess.id);
      }

      // Two students have already checked in to the live session.
      const liveRoster = all('SELECT student_id FROM enrollments WHERE section_id = ? ORDER BY created_at', live.id).map((r) => r.student_id);
      const early = [userIds[t.sis.classes[0].students[2]], userIds[t.sis.classes[0].students[4]]].filter((id) => id && liveRoster.includes(id));
      for (const sid of early) {
        const pos = offsetCoordinate(c.latitude, c.longitude, 25, -30);
        run(
          `INSERT INTO attendance_records (id, tenant_id, session_id, student_id, status, method, checked_in_at, latitude, longitude, accuracy_m, distance_m, updated_at)
           VALUES (?, ?, ?, ?, 'present', 'geo', ?, ?, ?, 10, 39, ?)`,
          newId(), tenantId, liveSessionId, sid, liveStart, pos.latitude, pos.longitude, nowIso,
        );
      }

      // Messaging: class channels plus a couple of direct conversations.
      for (const s of sections.filter((s) => s.period !== 'flex')) ensureSectionConversation(tenantId, s.id);
      const by = (sid) => userIds[sid];
      const teacher = by(t.sis.classes[0].teacher);
      const firstStudent = by(t.sis.classes[0].students[0]);
      const parentOfFirst = t.sis.users.find((u) => u.sourcedId === t.sis.classes[0].students[0])?.agents?.[0];
      const minutesAgo = (n) => new Date(now.getTime() - minutes(n)).toISOString();
      if (parentOfFirst) {
        directConversation(tenantId, [by(parentOfFirst), teacher], [
          [by(parentOfFirst), 'Hi! Quick question — did the unit quiz move to Friday?', minutesAgo(180)],
          [teacher, 'It did — Friday, first period. Happy to send a practice set home.', minutesAgo(172)],
        ]);
      }
      directConversation(tenantId, [teacher, firstStudent], [
        [teacher, 'Great work on the factoring worksheet. Try the challenge set in Math Lab on Thursday if you want a stretch.', minutesAgo(95)],
      ]);
      const classConv = one("SELECT id FROM conversations WHERE section_id = ? AND kind = 'section'", live.id);
      if (classConv) {
        run('INSERT INTO messages (id, tenant_id, conversation_id, sender_id, body, created_at) VALUES (?, ?, ?, ?, ?, ?)',
          newId(), tenantId, classConv.id, teacher, 'Reminder: bring your graphing calculators today.', minutesAgo(40));
        run('UPDATE conversations SET last_message_at = ? WHERE id = ?', minutesAgo(40), classConv.id);
      }

      // Announcements.
      const admin = by(t.sis.users.find((u) => u.role === 'administrator').sourcedId);
      run('INSERT INTO announcements (id, tenant_id, section_id, author_id, title, body, created_at) VALUES (?, ?, NULL, ?, ?, ?, ?)',
        newId(), tenantId, admin, 'Picture day is next Wednesday', 'Students should report to the gym during their English period. Retakes are in two weeks.', minutesAgo(60 * 26));
      run('INSERT INTO announcements (id, tenant_id, section_id, author_id, title, body, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
        newId(), tenantId, live.id, teacher, `${live.name}: quiz Friday`, 'Covers chapters 3–4. Review session in Math Lab on Thursday.', minutesAgo(60 * 3));

      // Requests: one pending flex-join, one pending excuse, one completed excuse.
      const flex = sections.find((s) => s.period === 'flex');
      const secondStudentSid = t.sis.classes[0].students[1];
      const secondStudent = by(secondStudentSid);
      const secondParent = t.sis.users.find((u) => u.sourcedId === secondStudentSid)?.agents?.[0];
      if (flex && secondStudent && flex.teacherId) {
        createSeedRequest(tenantId, {
          type: 'session_join', requester: secondStudent, student: secondStudent, sectionId: flex.id, approver: flex.teacherId,
          reason: 'I need help with factoring before Friday’s quiz.', data: {}, createdAt: minutesAgo(30),
        });
        run(`INSERT INTO notifications (id, tenant_id, user_id, kind, title, body, link, created_at) VALUES (?, ?, ?, 'request', ?, ?, '/requests', ?)`,
          newId(), tenantId, flex.teacherId, 'New flex request', `A student asked to join ${flex.name}.`, minutesAgo(30));
      }
      if (secondParent && by(secondParent)) {
        let next = addDays(today, 1);
        while ([0, 6].includes(weekday(next))) next = addDays(next, 1);
        createSeedRequest(tenantId, {
          type: 'absence_excuse', requester: by(secondParent), student: secondStudent, sectionId: null, approver: null,
          reason: 'Orthodontist appointment in the morning.', data: { date: next }, createdAt: minutesAgo(15),
        });
      }
      if (parentOfFirst) {
        let past = addDays(today, -6);
        while ([0, 6].includes(weekday(past))) past = addDays(past, -1);
        const reqId = createSeedRequest(tenantId, {
          type: 'absence_excuse', requester: by(parentOfFirst), student: firstStudent, sectionId: null, approver: admin,
          reason: 'Family emergency.', data: { date: past }, createdAt: minutesAgo(60 * 24 * 6), status: 'completed',
        });
        run(
          `UPDATE attendance_records SET status = 'excused', method = 'request', note = 'Excused via request', checked_in_at = NULL,
             latitude = NULL, longitude = NULL, accuracy_m = NULL, distance_m = NULL
           WHERE student_id = ? AND session_id IN (SELECT id FROM sessions WHERE tenant_id = ? AND starts_at >= ? AND starts_at < ?)`,
          firstStudent, tenantId, zonedToUtc(past, '00:00', t.timezone).toISOString(), zonedToUtc(addDays(past, 1), '00:00', t.timezone).toISOString(),
        );
        run(`INSERT INTO request_events (id, tenant_id, request_id, actor_id, event, note, created_at) VALUES (?, ?, ?, ?, 'approved', NULL, ?)`,
          newId(), tenantId, reqId, admin, minutesAgo(60 * 24 * 6 - 20));
        run(`INSERT INTO request_events (id, tenant_id, request_id, actor_id, event, note, created_at) VALUES (?, ?, ?, NULL, 'completed', 'Attendance updated for the day', ?)`,
          newId(), tenantId, reqId, minutesAgo(60 * 24 * 6 - 20));
      }

      // Integrations point at the bundled mock OneRoster / Canvas servers (relative URL = this server).
      for (const [kind, provider] of [['sis', 'oneroster'], ['lms', 'canvas']]) {
        run(
          `INSERT INTO integrations (id, tenant_id, kind, provider, base_url, client_id, client_secret, enabled, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?)`,
          newId(), tenantId, kind, provider, `/mock/${provider}/${t.slug}`, `orbit-${t.slug}`, `${t.slug}-secret`, nowIso,
        );
      }
    }
  });
}

function insertSession(tenantId, sectionId, startsAt, endsAt, status, createdAt) {
  const id = newId();
  run(
    `INSERT INTO sessions (id, tenant_id, section_id, starts_at, ends_at, status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)`,
    id, tenantId, sectionId, startsAt, endsAt, status, createdAt,
  );
  return id;
}

function directConversation(tenantId, members, messages) {
  const id = newId();
  const last = messages.at(-1)?.[2] ?? null;
  run(`INSERT INTO conversations (id, tenant_id, kind, created_by, created_at, last_message_at) VALUES (?, ?, 'direct', ?, ?, ?)`,
    id, tenantId, members[0], messages[0]?.[2] ?? last, last);
  for (const m of members) {
    run('INSERT INTO conversation_members (conversation_id, user_id, tenant_id, last_read_at) VALUES (?, ?, ?, ?)', id, m, tenantId, m === messages.at(-1)?.[0] ? last : null);
  }
  for (const [sender, body, at] of messages) {
    run('INSERT INTO messages (id, tenant_id, conversation_id, sender_id, body, created_at) VALUES (?, ?, ?, ?, ?, ?)', newId(), tenantId, id, sender, body, at);
  }
}

function createSeedRequest(tenantId, r) {
  const id = newId();
  run(
    `INSERT INTO requests (id, tenant_id, type, status, requester_id, student_id, section_id, approver_id, reason, data, decided_at, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    id, tenantId, r.type, r.status ?? 'pending', r.requester, r.student, r.sectionId, r.approver, r.reason, JSON.stringify(r.data),
    r.status ? r.createdAt : null, r.createdAt, r.createdAt,
  );
  run(`INSERT INTO request_events (id, tenant_id, request_id, actor_id, event, created_at) VALUES (?, ?, ?, ?, 'created', ?)`,
    newId(), tenantId, id, r.requester, r.createdAt);
  return id;
}

// CLI: `npm run seed` wipes the database file and re-seeds.
if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  if (process.argv.includes('--reset')) {
    for (const suffix of ['', '-wal', '-shm']) fs.rmSync(config.dbFile + suffix, { force: true });
  }
  openDatabase(config.dbFile);
  if (isSeeded()) {
    console.log('Database already seeded. Use --reset to start over.');
  } else {
    await seedDatabase();
    console.log(`Seeded demo data into ${config.dbFile}. Password for every demo account: ${DEMO_PASSWORD}`);
  }
  closeDatabase();
}
