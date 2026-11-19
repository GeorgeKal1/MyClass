import type { University } from "@myclass/shared";

/**
 * myClass serves the University of Piraeus only: every department signs in through the
 * university CAS on eclass.unipi.gr (Informatics additionally uses thales.cs.unipi.gr).
 */
export const UNIPI: University = {
  id: "unipi",
  name: "Πανεπιστήμιο Πειραιώς",
  nameEn: "University of Piraeus",
  eclassUrl: "https://eclass.unipi.gr",
  auth: "cas",
  status: "verified",
};

export const UNIVERSITIES: University[] = [UNIPI];

/** Always the University of Piraeus (older records may carry another id). */
export function getUniversity(_id?: string): University {
  return UNIPI;
}
