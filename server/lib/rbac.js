import { one, all } from '../db/database.js';
import { forbidden, notFound } from './http.js';

export const ROLES = ['admin', 'teacher', 'student', 'parent'];

/**
 * Role → permission matrix. Route-level checks use these; data-level scoping
 * (which sections / students a user can touch) is enforced by the policy helpers below.
 */
export const PERMISSIONS = {
  admin: [
    'users.read', 'users.manage', 'sections.manage', 'sessions.manage', 'attendance.mark',
    'attendance.view', 'requests.decide', 'announcements.post', 'integrations.manage',
    'campuses.manage', 'reports.view', 'messages.send', 'jobs.view',
  ],
  teacher: [
    'users.read', 'sessions.manage', 'attendance.mark', 'attendance.view', 'requests.decide',
    'announcements.post', 'reports.view', 'messages.send',
  ],
  student: ['attendance.checkin', 'attendance.view', 'requests.create', 'messages.send'],
  parent: ['attendance.view', 'requests.create', 'messages.send'],
};

export const hasPermission = (role, permission) => PERMISSIONS[role]?.includes(permission) ?? false;

/** Which request types each role may create. */
export const REQUEST_TYPES_BY_ROLE = {
  student: ['session_join'],
  parent: ['absence_excuse'],
  teacher: [],
  admin: [],
};

// ---------------------------------------------------------------------------
// Data-scope policies. All lookups are tenant-scoped: a row in another tenant
// is reported as "not found" so its existence is never revealed.
// ---------------------------------------------------------------------------

export function childIdsOf(user) {
  return all('SELECT student_id FROM guardianships WHERE parent_id = ? AND tenant_id = ?', user.id, user.tenantId).map(
    (r) => r.student_id,
  );
}

/** Student ids the user may see, or null meaning "every student in the tenant". */
export function visibleStudentIds(user) {
  switch (user.role) {
    case 'admin':
      return null;
    case 'teacher':
      return all(
        `SELECT DISTINCT e.student_id FROM enrollments e JOIN sections s ON s.id = e.section_id
         WHERE s.teacher_id = ? AND s.tenant_id = ?`,
        user.id,
        user.tenantId,
      ).map((r) => r.student_id);
    case 'student':
      return [user.id];
    case 'parent':
      return childIdsOf(user);
    default:
      return [];
  }
}

export function canViewStudent(user, studentId) {
  const ids = visibleStudentIds(user);
  return ids === null || ids.includes(studentId);
}

export function assertCanViewStudent(user, studentId) {
  const student = one("SELECT id FROM users WHERE id = ? AND tenant_id = ? AND role = 'student'", studentId, user.tenantId);
  if (!student) throw notFound('Student');
  if (!canViewStudent(user, studentId)) throw forbidden('You cannot view this student');
}

/** Section ids visible to the user, or null for all. */
export function visibleSectionIds(user) {
  switch (user.role) {
    case 'admin':
      return null;
    case 'teacher':
      return all('SELECT id FROM sections WHERE teacher_id = ? AND tenant_id = ?', user.id, user.tenantId).map((r) => r.id);
    case 'student':
      return all('SELECT section_id FROM enrollments WHERE student_id = ? AND tenant_id = ?', user.id, user.tenantId).map(
        (r) => r.section_id,
      );
    case 'parent': {
      const kids = childIdsOf(user);
      if (!kids.length) return [];
      return all(
        `SELECT DISTINCT section_id FROM enrollments WHERE tenant_id = ? AND student_id IN (${kids.map(() => '?').join(',')})`,
        user.tenantId,
        ...kids,
      ).map((r) => r.section_id);
    }
    default:
      return [];
  }
}

/**
 * Load a section the user is allowed to access.
 * mode 'read'  → anyone who can see it; mode 'manage' → its teacher or an admin.
 */
export function loadSectionFor(user, sectionId, mode = 'read') {
  const section = one('SELECT * FROM sections WHERE id = ? AND tenant_id = ?', sectionId, user.tenantId);
  if (!section) throw notFound('Section');
  if (user.role === 'admin') return section;
  if (mode === 'manage') {
    if (user.role === 'teacher' && section.teacher_id === user.id) return section;
    throw forbidden('Only this section’s teacher or an admin can do that');
  }
  const ids = visibleSectionIds(user);
  // Students may also see flex sections they are not enrolled in, so they can request to join.
  if (ids.includes(sectionId) || (user.role === 'student' && section.kind === 'flex')) return section;
  throw forbidden('You do not have access to this section');
}

/**
 * Messaging policy (a common school safeguarding rule):
 * - admins can message anyone in their school
 * - teachers can message staff, plus students/parents connected to their sections
 * - students can message staff connected to them (their teachers, admins) — never other students
 * - parents can message their children’s teachers and admins
 */
export function messagingContacts(user) {
  const t = user.tenantId;
  if (user.role === 'admin') {
    return all("SELECT id, name, role FROM users WHERE tenant_id = ? AND id != ? AND status != 'inactive' ORDER BY role, name", t, user.id);
  }
  if (user.role === 'teacher') {
    return all(
      `SELECT id, name, role FROM users WHERE tenant_id = ? AND id != ? AND status != 'inactive' AND (
         role IN ('admin','teacher')
         OR id IN (SELECT e.student_id FROM enrollments e JOIN sections s ON s.id = e.section_id WHERE s.teacher_id = ?)
         OR id IN (SELECT g.parent_id FROM guardianships g JOIN enrollments e ON e.student_id = g.student_id
                   JOIN sections s ON s.id = e.section_id WHERE s.teacher_id = ?)
       ) ORDER BY role, name`,
      t, user.id, user.id, user.id,
    );
  }
  const studentIds = user.role === 'student' ? [user.id] : childIdsOf(user);
  if (!studentIds.length) {
    return all("SELECT id, name, role FROM users WHERE tenant_id = ? AND role = 'admin' AND status != 'inactive' ORDER BY name", t);
  }
  const ph = studentIds.map(() => '?').join(',');
  return all(
    `SELECT id, name, role FROM users WHERE tenant_id = ? AND status != 'inactive' AND (
       role = 'admin'
       OR id IN (SELECT s.teacher_id FROM sections s JOIN enrollments e ON e.section_id = s.id WHERE e.student_id IN (${ph}))
     ) ORDER BY role, name`,
    t, ...studentIds,
  );
}

export function canMessage(user, otherUserId) {
  return messagingContacts(user).some((c) => c.id === otherUserId);
}
