import "dotenv/config";
import { detectUniversityId } from "@myclass/shared";
import {
  getConnectorForUser,
  performEclassLogin,
  portalsForUser,
  setTransientCredentials,
} from "../src/eclass/connector.js";
import { getUniversity } from "../src/eclass/universities.js";
import { newUser } from "../src/store.js";

/**
 * Live diagnostic for one student account. Nothing is stored: the user record only lives in memory.
 *
 *   PROBE_USERNAME=e24xxx PROBE_PASSWORD=... npm run probe
 *   (optionally PROBE_UNIVERSITY=unipi; otherwise it is detected from the username)
 *
 * Prints, per step and per eClass portal, what worked and what failed – never the password.
 */
async function step<T>(label: string, fn: () => Promise<T>): Promise<T | undefined> {
  const started = Date.now();
  try {
    const res = await fn();
    console.log(`✓ ${label} (${Date.now() - started} ms)`);
    return res;
  } catch (err) {
    console.log(`✗ ${label}: ${(err as Error).message}`);
    return undefined;
  }
}

async function main() {
  const username = process.env.PROBE_USERNAME?.trim();
  const password = process.env.PROBE_PASSWORD;
  const uniId = process.env.PROBE_UNIVERSITY || (username ? detectUniversityId(username) : null) || "unipi";
  const uni = getUniversity(uniId);
  if (!uni) throw new Error(`Unknown university: ${uniId}`);

  console.log(`[probe] University: ${uni.nameEn} (${uni.eclassUrl})`);
  if (!username || !password) {
    console.log("Set PROBE_USERNAME and PROBE_PASSWORD (env or apps/server/.env) to test a live login.");
    return;
  }
  console.log(`[probe] Portals for ${username}: ${portalsForUser(uni, username).join(", ")}`);

  const login = await step("SSO login + eClass session", () => performEclassLogin(uni, username, password));
  if (!login) return;
  console.log(`  display name: ${login.displayName}`);

  const user = newUser("probe-" + Date.now(), uni.id, username); // in memory only
  user.remember = false;
  setTransientCredentials(user.id, password, login.http.serialize());
  const connector = getConnectorForUser(user);

  const courses = await step("Enrolled courses", () => connector.listCoursesDetailed());
  if (courses) {
    console.log(`  ${courses.courses.length} course(s)`);
    for (const c of courses.courses.slice(0, 15)) console.log(`   - [${c.portal}] ${c.code} ${c.title}`);
    for (const w of courses.warnings) console.log(`  ! ${w.portal}: ${w.message}`);
  }

  const depts = await step("Departments", () => connector.listDepartments());
  if (depts) console.log(`  default: ${connector.defaultDepartmentId()} · ${depts.length} option(s)`);

  const catalog = await step("Department catalog", () => connector.listCatalog());
  if (catalog) console.log(`  ${catalog.length} course(s), ${catalog.filter((c) => c.enrolled).length} marked enrolled`);

  const assignments = await step("Assignments", () => connector.getAssignments());
  if (assignments) console.log(`  ${assignments.length} assignment(s) this academic year`);

  const announcements = await step("Announcements", () => connector.getAnnouncements());
  if (announcements) console.log(`  ${announcements.length} announcement(s)`);

  const first = courses?.courses[0];
  if (first) {
    const tools = await step(`Tools of ${first.code}`, () => connector.getCourseTools(first.code));
    if (tools) console.log(`  ${tools.map((t) => t.id).join(", ")}`);
    const docs = await step(`Documents of ${first.code}`, () => connector.listDocuments(first.code));
    if (docs) console.log(`  ${docs.length} item(s) in /`);
  }
}

main().catch((err) => {
  console.error("✗ Probe failed:", err);
  process.exit(1);
});
