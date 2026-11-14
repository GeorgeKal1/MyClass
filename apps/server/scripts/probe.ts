import "dotenv/config";
import { performEclassLogin } from "../src/eclass/connector.js";
import { getUniversity } from "../src/eclass/universities.js";

async function main() {
  const uniId = process.env.PROBE_UNIVERSITY || "unipi";
  const username = process.env.PROBE_USERNAME;
  const password = process.env.PROBE_PASSWORD;
  const uni = getUniversity(uniId);
  if (!uni) throw new Error(`Unknown university: ${uniId}`);

  console.log(`[probe] University: ${uni.name} (${uni.eclassUrl})`);
  if (!username || !password) {
    console.log(
      "Set PROBE_USERNAME and PROBE_PASSWORD in apps/server/.env to test a live CAS login against eClass.",
    );
    return;
  }

  const { displayName } = await performEclassLogin(uni, username, password);
  console.log(`✓ Authenticated as: ${displayName}`);
}

main().catch((err) => {
  console.error("✗ Probe failed:", err);
  process.exit(1);
});
