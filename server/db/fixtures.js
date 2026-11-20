/**
 * Canonical demo data for two fictional schools.
 *
 * `sis` is what each school's Student Information System (OneRoster) knows about.
 * Records flagged `seed: false` exist only in the SIS, so running a SIS sync in the
 * app visibly imports them (new students, a new class, and one withdrawn student).
 * `lms` lists the Canvas course/user ids that the mock LMS hands out.
 */
export const DEMO_PASSWORD = 'orbit123';

export const TENANTS = [
  {
    slug: 'northfield',
    name: 'Northfield High School',
    timezone: 'America/New_York',
    campus: { name: 'Northfield — Main Campus', address: '100 Orbit Way', latitude: 42.3505, longitude: -71.0726, radius_m: 200 },
    sis: {
      users: [
        { sourcedId: 'nf-adm-1', role: 'administrator', givenName: 'Dana', familyName: 'Whitfield', email: 'admin@northfield.test' },
        { sourcedId: 'nf-tch-1', role: 'teacher', givenName: 'Marcus', familyName: 'Reed', email: 'm.reed@northfield.test' },
        { sourcedId: 'nf-tch-2', role: 'teacher', givenName: 'Priya', familyName: 'Shah', email: 'p.shah@northfield.test' },
        { sourcedId: 'nf-tch-3', role: 'teacher', givenName: 'Elena', familyName: 'Torres', email: 'e.torres@northfield.test' },
        { sourcedId: 'nf-stu-1', role: 'student', givenName: 'Ava', familyName: 'Johnson', email: 'ava@northfield.test', grade: '10', agents: ['nf-par-1'] },
        { sourcedId: 'nf-stu-2', role: 'student', givenName: 'Liam', familyName: 'Chen', email: 'liam@northfield.test', grade: '10', agents: ['nf-par-2'] },
        { sourcedId: 'nf-stu-3', role: 'student', givenName: 'Sofia', familyName: 'Martinez', email: 'sofia@northfield.test', grade: '10' },
        { sourcedId: 'nf-stu-4', role: 'student', givenName: 'Noah', familyName: 'Williams', email: 'noah@northfield.test', grade: '10' },
        { sourcedId: 'nf-stu-5', role: 'student', givenName: 'Maya', familyName: 'Patel', email: 'maya@northfield.test', grade: '10' },
        { sourcedId: 'nf-stu-6', role: 'student', givenName: 'Ethan', familyName: 'Brooks', email: 'ethan@northfield.test', grade: '10' },
        { sourcedId: 'nf-stu-7', role: 'student', givenName: 'Zoe', familyName: 'Kim', email: 'zoe@northfield.test', grade: '10' },
        { sourcedId: 'nf-stu-8', role: 'student', givenName: 'Lucas', familyName: 'Rivera', email: 'lucas@northfield.test', grade: '10', sisStatus: 'tobedeleted' },
        { sourcedId: 'nf-par-1', role: 'parent', givenName: 'Rachel', familyName: 'Johnson', email: 'rachel.johnson@northfield.test' },
        { sourcedId: 'nf-par-2', role: 'parent', givenName: 'David', familyName: 'Chen', email: 'david.chen@northfield.test' },
        // Only in the SIS — imported on first sync.
        { sourcedId: 'nf-stu-9', role: 'student', givenName: 'Jordan', familyName: 'Blake', email: 'jordan@northfield.test', grade: '10', seed: false },
        { sourcedId: 'nf-stu-10', role: 'student', givenName: 'Amara', familyName: 'Okafor', email: 'amara@northfield.test', grade: '10', seed: false },
        { sourcedId: 'nf-stu-11', role: 'student', givenName: 'Caleb', familyName: 'Nguyen', email: 'caleb@northfield.test', grade: '10', seed: false },
      ],
      classes: [
        { sourcedId: 'nf-cls-alg1', title: 'Algebra I', classCode: 'MATH-101', location: 'Room 204', teacher: 'nf-tch-1', period: 1,
          students: ['nf-stu-1', 'nf-stu-2', 'nf-stu-3', 'nf-stu-4', 'nf-stu-5'] },
        { sourcedId: 'nf-cls-bio', title: 'Biology', classCode: 'SCI-110', location: 'Lab 2', teacher: 'nf-tch-2', period: 2,
          students: ['nf-stu-1', 'nf-stu-2', 'nf-stu-6', 'nf-stu-7', 'nf-stu-8'] },
        { sourcedId: 'nf-cls-eng10', title: 'English 10', classCode: 'ENG-210', location: 'Room 112', teacher: 'nf-tch-3', period: 3,
          students: ['nf-stu-1', 'nf-stu-3', 'nf-stu-4', 'nf-stu-5', 'nf-stu-6', 'nf-stu-7'] },
        { sourcedId: 'nf-cls-robotics', title: 'Robotics Lab', classCode: 'ENG-ROB', location: 'Makerspace', teacher: 'nf-tch-2', period: 4,
          students: ['nf-stu-6', 'nf-stu-9', 'nf-stu-10', 'nf-stu-11'], seed: false },
      ],
      // Students the SIS adds to existing classes (not in the seed).
      extraEnrollments: [{ class: 'nf-cls-alg1', student: 'nf-stu-9' }],
    },
    flex: [
      { name: 'Math Lab', courseCode: 'FLEX-MATH', room: 'Room 204', teacher: 'nf-tch-1', capacity: 6, students: ['nf-stu-4'] },
      { name: 'Writing Center', courseCode: 'FLEX-WRITE', room: 'Library', teacher: 'nf-tch-3', capacity: 4, students: [] },
    ],
    lms: {
      courses: { 'nf-cls-alg1': 1101, 'nf-cls-bio': 1102, 'nf-cls-eng10': 1103, 'nf-cls-robotics': 1104 },
      userIdBase: 5000,
    },
  },
  {
    slug: 'riverside',
    name: 'Riverside Academy',
    timezone: 'America/Chicago',
    campus: { name: 'Riverside Academy', address: '2 Riverbend Rd', latitude: 41.8789, longitude: -87.6359, radius_m: 150 },
    sis: {
      users: [
        { sourcedId: 'rv-adm-1', role: 'administrator', givenName: 'Grace', familyName: 'Holloway', email: 'admin@riverside.test' },
        { sourcedId: 'rv-tch-1', role: 'teacher', givenName: 'Omar', familyName: 'Haddad', email: 'o.haddad@riverside.test' },
        { sourcedId: 'rv-stu-1', role: 'student', givenName: 'Isla', familyName: 'Grant', email: 'isla@riverside.test', grade: '9', agents: ['rv-par-1'] },
        { sourcedId: 'rv-stu-2', role: 'student', givenName: 'Mateo', familyName: 'Silva', email: 'mateo@riverside.test', grade: '9' },
        { sourcedId: 'rv-stu-3', role: 'student', givenName: 'Nora', familyName: 'Fischer', email: 'nora@riverside.test', grade: '9' },
        { sourcedId: 'rv-par-1', role: 'parent', givenName: 'Helen', familyName: 'Grant', email: 'helen.grant@riverside.test' },
      ],
      classes: [
        { sourcedId: 'rv-cls-chem', title: 'Chemistry', classCode: 'SCI-201', location: 'Lab A', teacher: 'rv-tch-1', period: 1,
          students: ['rv-stu-1', 'rv-stu-2', 'rv-stu-3'] },
      ],
      extraEnrollments: [],
    },
    flex: [{ name: 'Study Hall', courseCode: 'FLEX-STUDY', room: 'Commons', teacher: 'rv-tch-1', capacity: 10, students: [] }],
    lms: { courses: { 'rv-cls-chem': 2101 }, userIdBase: 9000 },
  },
];

/** Bell schedule: period → local start/end time. */
export const PERIODS = {
  1: ['08:00', '08:50'],
  2: ['09:00', '09:50'],
  3: ['10:00', '10:50'],
  4: ['11:00', '11:50'],
  flex: ['13:30', '14:15'],
};

export const ROLE_MAP = { administrator: 'admin', teacher: 'teacher', student: 'student', parent: 'parent', guardian: 'parent' };

export const fullName = (u) => `${u.givenName} ${u.familyName}`;
