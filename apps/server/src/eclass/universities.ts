import type { University } from "@myclass/shared";

/**
 * Registry of supported Open eClass installations.
 *
 * `status`:
 *  - verified: connector tested end-to-end against the live site
 *  - beta:     CAS flow inspected (form fields / redirects), parsers being validated
 *  - untested: standard Open eClass + CAS assumed; may need an adapter override
 *
 * Adding a university is usually just a new entry here. The CAS endpoint is
 * auto-discovered from `/modules/mobile/midentity.php` at login time.
 */
export const UNIVERSITIES: University[] = [
  {
    id: "unipi",
    name: "Πανεπιστήμιο Πειραιώς",
    nameEn: "University of Piraeus",
    eclassUrl: "https://eclass.unipi.gr",
    auth: "cas",
    status: "verified",
  },
  {
    id: "uoa",
    name: "Εθνικό και Καποδιστριακό Πανεπιστήμιο Αθηνών",
    nameEn: "National and Kapodistrian University of Athens",
    eclassUrl: "https://eclass.uoa.gr",
    auth: "cas",
    status: "untested",
  },
  {
    id: "ntua",
    name: "Εθνικό Μετσόβιο Πολυτεχνείο",
    nameEn: "National Technical University of Athens",
    eclassUrl: "https://mycourses.ntua.gr",
    auth: "cas",
    status: "untested",
  },
  {
    id: "aueb",
    name: "Οικονομικό Πανεπιστήμιο Αθηνών",
    nameEn: "Athens University of Economics and Business",
    eclassUrl: "https://eclass.aueb.gr",
    auth: "cas",
    status: "untested",
  },
  {
    id: "uniwa",
    name: "Πανεπιστήμιο Δυτικής Αττικής",
    nameEn: "University of West Attica",
    eclassUrl: "https://eclass.uniwa.gr",
    auth: "cas",
    status: "untested",
  },
  {
    id: "panteion",
    name: "Πάντειο Πανεπιστήμιο",
    nameEn: "Panteion University",
    eclassUrl: "https://openeclass.panteion.gr",
    auth: "cas",
    status: "untested",
  },
  {
    id: "hua",
    name: "Χαροκόπειο Πανεπιστήμιο",
    nameEn: "Harokopio University",
    eclassUrl: "https://eclass.hua.gr",
    auth: "cas",
    status: "untested",
  },
  {
    id: "uom",
    name: "Πανεπιστήμιο Μακεδονίας",
    nameEn: "University of Macedonia",
    eclassUrl: "https://openeclass.uom.gr",
    auth: "cas",
    status: "untested",
  },
  {
    id: "upatras",
    name: "Πανεπιστήμιο Πατρών",
    nameEn: "University of Patras",
    eclassUrl: "https://eclass.upatras.gr",
    auth: "cas",
    status: "untested",
  },
  {
    id: "duth",
    name: "Δημοκρίτειο Πανεπιστήμιο Θράκης",
    nameEn: "Democritus University of Thrace",
    eclassUrl: "https://eclass.duth.gr",
    auth: "cas",
    status: "untested",
  },
  {
    id: "uth",
    name: "Πανεπιστήμιο Θεσσαλίας",
    nameEn: "University of Thessaly",
    eclassUrl: "https://eclass.uth.gr",
    auth: "cas",
    status: "untested",
  },
  {
    id: "uowm",
    name: "Πανεπιστήμιο Δυτικής Μακεδονίας",
    nameEn: "University of Western Macedonia",
    eclassUrl: "https://eclass.uowm.gr",
    auth: "cas",
    status: "untested",
  },
  {
    id: "uop",
    name: "Πανεπιστήμιο Πελοποννήσου",
    nameEn: "University of the Peloponnese",
    eclassUrl: "https://eclass.uop.gr",
    auth: "cas",
    status: "untested",
  },
  {
    id: "hmu",
    name: "Ελληνικό Μεσογειακό Πανεπιστήμιο",
    nameEn: "Hellenic Mediterranean University",
    eclassUrl: "https://eclass.hmu.gr",
    auth: "cas",
    status: "untested",
  },
  {
    // Open eClass 4.4 – login redirects to the university CAS at sso.aegean.gr
    id: "aegean",
    name: "Πανεπιστήμιο Αιγαίου",
    nameEn: "University of the Aegean",
    eclassUrl: "https://eclass.aegean.gr",
    auth: "cas",
    status: "beta",
  },
  {
    id: "uoi",
    name: "Πανεπιστήμιο Ιωαννίνων",
    nameEn: "University of Ioannina",
    eclassUrl: "https://eclass.uoi.gr",
    auth: "cas",
    status: "untested",
  },
];

export function getUniversity(id: string): University | undefined {
  return UNIVERSITIES.find((u) => u.id === id);
}
