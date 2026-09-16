/**
 * Seeds the single Owner/Admin — the only account that is never self-registered —
 * and, when SEED_DEMO_DATA is true, a month of realistic teaching history so the
 * dashboards, attendance and payroll screens have something true to show.
 *
 *   npm run -w apps/server seed
 */
import { PrismaClient, type Subject, type User } from '@prisma/client';
import { env } from '../src/env.js';
import { hashPassword } from '../src/lib/password.js';
import { deductionForCents } from '../src/services/payroll.js';

const prisma = new PrismaClient();
const DAY = 86_400_000;
const HOUR = 3_600_000;
const at = (offsetDays: number, hour = 15, minute = 0): Date => {
  const d = new Date(Date.now() + offsetDays * DAY);
  d.setHours(hour, minute, 0, 0);
  return d;
};

async function main(): Promise<void> {
  const owner = await prisma.user.upsert({
    where: { email: env.SEED_OWNER_EMAIL },
    update: {},
    create: {
      email: env.SEED_OWNER_EMAIL,
      name: env.SEED_OWNER_NAME,
      passwordHash: await hashPassword(env.SEED_OWNER_PASSWORD),
      role: 'OWNER',
      status: 'ACTIVE',
      timezone: 'America/New_York',
      seeded: true,
    },
  });
  console.log(`Owner ready: ${owner.email}`);

  if (!env.SEED_DEMO_DATA) {
    console.log('SEED_DEMO_DATA is false — stopping after the Owner.');
    return;
  }

  const people: Array<Parameters<typeof prisma.user.create>[0]['data'] & { email: string }> = [
    { email: 'daniel@logicclass.plus', name: 'Daniel Okafor', passwordHash: await hashPassword('teach1234'),
      role: 'TEACHER', status: 'ACTIVE', locale: 'en-GB', timezone: 'Europe/London',
      subjects: ['MATH'], hourlyRateCents: 2600, bio: 'Algebra & calculus. 8 years, IB and A-Level.' },
    { email: 'hana@logicclass.plus', name: 'Hana Sato', passwordHash: await hashPassword('teach1234'),
      role: 'TEACHER', status: 'ACTIVE', locale: 'en-US', timezone: 'Asia/Tokyo',
      subjects: ['ENGLISH'], hourlyRateCents: 2400, bio: 'Pronunciation, IELTS speaking, business English.' },
    { email: 'paolo@logicclass.plus', name: 'Paolo Mendes', passwordHash: await hashPassword('teach1234'),
      role: 'TEACHER', status: 'PENDING', locale: 'pt-BR', timezone: 'America/Sao_Paulo',
      subjects: ['MATH', 'ENGLISH'], hourlyRateCents: 2200, bio: 'Bilingual tutor, primary and lower secondary.' },
    { email: 'amira@logicclass.plus', name: 'Amira Haddad', passwordHash: await hashPassword('learn1234'),
      role: 'STUDENT', status: 'ACTIVE', locale: 'ar-AE', timezone: 'Asia/Dubai',
      subjects: ['MATH'], gradeLevel: 'Year 10' },
    { email: 'kenji@logicclass.plus', name: 'Kenji Watanabe', passwordHash: await hashPassword('learn1234'),
      role: 'STUDENT', status: 'ACTIVE', locale: 'ja-JP', timezone: 'Asia/Tokyo',
      subjects: ['ENGLISH'], gradeLevel: 'Adult / B2' },
    { email: 'lucia@logicclass.plus', name: 'Lucia Ferrari', passwordHash: await hashPassword('learn1234'),
      role: 'STUDENT', status: 'ACTIVE', locale: 'it-IT', timezone: 'Europe/Rome',
      subjects: ['MATH', 'ENGLISH'], gradeLevel: 'Year 12' },
    { email: 'tomas@logicclass.plus', name: 'Tomás Rivas', passwordHash: await hashPassword('learn1234'),
      role: 'STUDENT', status: 'PENDING', locale: 'es-CL', timezone: 'America/Santiago',
      subjects: ['MATH'], gradeLevel: 'Year 8' },
  ];

  const byEmail = new Map<string, User>();
  for (const person of people) {
    const user = await prisma.user.upsert({
      where: { email: person.email }, update: {}, create: person,
    });
    byEmail.set(person.email, user);
  }
  const u = (email: string): User => {
    const found = byEmail.get(email);
    if (!found) throw new Error(`seed: missing ${email}`);
    return found;
  };

  const daniel = u('daniel@logicclass.plus');
  const hana = u('hana@logicclass.plus');
  const amira = u('amira@logicclass.plus');
  const kenji = u('kenji@logicclass.plus');
  const lucia = u('lucia@logicclass.plus');

  if (await prisma.folder.count() === 0) {
    const folders = await Promise.all([
      prisma.folder.create({ data: { teacherId: daniel.id, name: 'Quadratics', subject: 'MATH' } }),
      prisma.folder.create({ data: { teacherId: daniel.id, name: 'Differentiation', subject: 'MATH' } }),
      prisma.folder.create({ data: { teacherId: hana.id, name: 'IELTS Speaking Part 2', subject: 'ENGLISH' } }),
      prisma.folder.create({ data: { teacherId: hana.id, name: 'Minimal Pairs Drills', subject: 'ENGLISH' } }),
    ]);
    const files: Array<[number, string, string, number]> = [
      [0, 'completing-the-square.pdf', 'pdf', 842_115],
      [0, 'discriminant-worksheet.pdf', 'pdf', 311_402],
      [1, 'chain-rule-board.png', 'png', 1_204_880],
      [2, 'cue-cards-band7.docx', 'docx', 96_640],
      [3, 'ship-sheep-model.mp3', 'mp3', 2_998_144],
      [3, 'th-sounds-drill.mp3', 'mp3', 3_410_222],
    ];
    for (const [folderIndex, name, ext, bytes] of files) {
      const folder = folders[folderIndex]!;
      await prisma.resource.create({
        data: {
          folderId: folder.id, teacherId: folder.teacherId, name, ext, bytes,
          storageKey: `teachers/${folder.teacherId}/folders/${folder.id}/${name}`,
        },
      });
    }
  }

  if (await prisma.announcement.count() === 0) {
    await prisma.announcement.createMany({
      data: [
        { authorId: owner.id, title: 'October payroll closes Friday 18:00 UTC',
          body: 'Clock-out on every session before the cutoff. Anything logged after Friday rolls into the November batch.',
          audience: 'TEACHERS', pinned: true, createdAt: new Date(Date.now() - 2 * DAY) },
        { authorId: owner.id, title: 'New: pronunciation scoring in the English suite',
          body: 'Recordings made in class now return a per-phoneme score. Teachers, please review the report with the student before ending the session.',
          audience: 'ALL', createdAt: new Date(Date.now() - 6 * DAY) },
        { authorId: owner.id, title: 'Scheduled maintenance — Sunday 02:00–03:00 UTC',
          body: 'Classrooms will be unavailable for roughly one hour. No sessions are scheduled in that window.',
          audience: 'ALL', createdAt: new Date(Date.now() - 11 * DAY) },
      ],
    });
  }

  if (await prisma.classSession.count() === 0) {
    // One upcoming class, ready to enter.
    const upcoming = await prisma.classRequest.create({
      data: {
        studentId: amira.id, teacherId: daniel.id, subject: 'MATH',
        topic: 'Completing the square — homework 4',
        note: 'I get lost when the coefficient of x² is not 1.',
        requestedFor: new Date(Date.now() + 1.5 * HOUR), minutes: 60, status: 'ACCEPTED',
      },
    });
    await prisma.classSession.create({
      data: {
        requestId: upcoming.id, teacherId: daniel.id, studentId: amira.id, subject: 'MATH',
        topic: upcoming.topic, startsAt: upcoming.requestedFor, minutes: 60, status: 'SCHEDULED',
      },
    });

    // Two requests still waiting on a teacher.
    await prisma.classRequest.createMany({
      data: [
        { studentId: kenji.id, teacherId: hana.id, subject: 'ENGLISH',
          topic: 'IELTS Part 2 — describing a place', note: 'Exam is in three weeks.',
          requestedFor: new Date(Date.now() + 4 * HOUR), minutes: 45 },
        { studentId: lucia.id, teacherId: daniel.id, subject: 'MATH',
          topic: 'Chain rule practice', requestedFor: new Date(Date.now() + 26 * HOUR), minutes: 60 },
      ],
    });

    // A month of delivered teaching, with attendance and the deductions it implies.
    const history: Array<{ teacher: User; students: User[]; subject: Subject; minutes: number; topics: string[] }> = [
      { teacher: daniel, students: [amira, lucia], subject: 'MATH', minutes: 60,
        topics: ['Factorising quadratics', 'Simultaneous equations', 'Circle theorems', 'Indices and surds',
                 'Differentiation practice', 'Word problems — rates', 'Probability trees'] },
      { teacher: hana, students: [kenji, lucia], subject: 'ENGLISH', minutes: 45,
        topics: ['Past perfect vs past simple', 'Linking words in Part 3', 'Word stress in long nouns',
                 'Describing trends', 'Phrasal verbs at work', 'Reading for gist', 'Connected speech'] },
    ];
    const lateCycle = [0, 0, 3, 0, 9, 1, 0];

    for (const track of history) {
      for (let i = 0; i < track.topics.length; i += 1) {
        const startsAt = at(-(i * 3 + 1.5), i % 2 ? 15 : 10, i % 2 ? 15 : 30);
        const late = lateCycle[(i + (track.teacher.id === hana.id ? 3 : 0)) % lateCycle.length]!;
        const student = track.students[i % track.students.length]!;

        const session = await prisma.classSession.create({
          data: {
            teacherId: track.teacher.id, studentId: student.id, subject: track.subject,
            topic: track.topics[i]!, startsAt, minutes: track.minutes, status: 'COMPLETED',
            joinedAt: new Date(startsAt.getTime() + late * 60_000),
            endedAt: new Date(startsAt.getTime() + (track.minutes + late) * 60_000),
          },
        });
        await prisma.attendance.create({
          data: {
            teacherId: track.teacher.id, sessionId: session.id, scheduledStart: startsAt,
            clockIn: new Date(startsAt.getTime() + late * 60_000),
            clockOut: new Date(startsAt.getTime() + (track.minutes + late) * 60_000),
            minutesLate: late,
            deductionCents: deductionForCents(
              { minutesLate: late, noShow: false }, track.minutes, track.teacher.hourlyRateCents ?? 0,
            ),
          },
        });
      }
    }

    // One no-show, so the forfeit rule is visible on a real record.
    const missed = await prisma.classSession.create({
      data: {
        teacherId: daniel.id, studentId: amira.id, subject: 'MATH', topic: 'Simultaneous equations',
        startsAt: at(-26, 16), minutes: 60, status: 'NO_SHOW',
      },
    });
    await prisma.attendance.create({
      data: {
        teacherId: daniel.id, sessionId: missed.id, scheduledStart: missed.startsAt, noShow: true,
        deductionCents: deductionForCents({ minutesLate: 0, noShow: true }, 60, daniel.hourlyRateCents ?? 0),
      },
    });
  }

  if (await prisma.invoice.count() === 0) {
    await prisma.invoice.create({
      data: {
        number: 'LC-2041', studentId: amira.id, amountCents: 15_600, status: 'PAID',
        issuedAt: new Date(Date.now() - 26 * DAY), dueAt: new Date(Date.now() - 12 * DAY),
        paidAt: new Date(Date.now() - 14 * DAY),
        lines: { create: [{ label: '6 × Math, 60 min', amountCents: 15_600 }] },
      },
    });
    await prisma.invoice.create({
      data: {
        number: 'LC-2042', studentId: kenji.id, amountCents: 9_000, status: 'OPEN',
        issuedAt: new Date(Date.now() - 5 * DAY), dueAt: new Date(Date.now() + 9 * DAY),
        lines: { create: [{ label: '4 × English, 45 min', amountCents: 9_000 }] },
      },
    });
    await prisma.invoice.create({
      data: {
        number: 'LC-2043', studentId: lucia.id, amountCents: 20_400, status: 'OPEN',
        issuedAt: new Date(Date.now() - 1 * DAY), dueAt: new Date(Date.now() + 13 * DAY),
        lines: {
          create: [
            { label: '5 × Math, 60 min', amountCents: 13_000 },
            { label: '3 × English, 45 min', amountCents: 7_400 },
          ],
        },
      },
    });
  }

  if (await prisma.passwordResetRequest.count() === 0) {
    const tomas = u('tomas@logicclass.plus');
    await prisma.passwordResetRequest.create({
      data: { userId: tomas.id, email: tomas.email, requestedAt: new Date(Date.now() - 9 * HOUR) },
    });
  }

  if (await prisma.notification.count() === 0) {
    await prisma.notification.createMany({
      data: [
        { userId: daniel.id, type: 'class_request', title: 'New class request',
          body: 'Lucia Ferrari requested Math — Chain rule practice.', createdAt: new Date(Date.now() - 5 * HOUR) },
        { userId: hana.id, type: 'class_request', title: 'New class request',
          body: 'Kenji Watanabe requested English — IELTS Part 2.', createdAt: new Date(Date.now() - 40 * 60_000) },
        { userId: owner.id, type: 'account', title: 'Teacher awaiting approval',
          body: 'Paolo Mendes registered 2 days ago and is still pending.', createdAt: new Date(Date.now() - 2 * DAY) },
        { userId: owner.id, type: 'password', title: 'Password reset requested',
          body: 'Tomás Rivas asked for a reset link.', createdAt: new Date(Date.now() - 9 * HOUR) },
        { userId: amira.id, type: 'session', title: 'Class accepted',
          body: 'Daniel Okafor accepted your request for today.', createdAt: new Date(Date.now() - 100 * 60_000) },
      ],
    });
  }

  const counts = {
    users: await prisma.user.count(),
    folders: await prisma.folder.count(),
    resources: await prisma.resource.count(),
    sessions: await prisma.classSession.count(),
    attendance: await prisma.attendance.count(),
    invoices: await prisma.invoice.count(),
  };
  console.log('Seed complete:', counts);
}

main()
  .catch((err) => { console.error(err); process.exit(1); })
  .finally(() => void prisma.$disconnect());
