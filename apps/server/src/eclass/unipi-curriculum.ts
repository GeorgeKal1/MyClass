import type { Announcement, Assignment, DepartmentInfo, DocNode } from "@myclass/shared";

export const THALES_BASE_URL = "https://thales.cs.unipi.gr";
export const UNIPI_CENTRAL_BASE_URL = "https://eclass.unipi.gr";
/** Digital Systems runs its own Open eClass instances: "Αρίσταρχος" (undergraduate) and "Λεύκιππος" (MSc). */
export const ARISTARCHUS_BASE_URL = "https://aristarchus.ds.unipi.gr";
export const LEFKIPPOS_BASE_URL = "https://lefkippos.ds.unipi.gr";

/** The Open eClass portals UniPi students use. All of them sign in through sso.unipi.gr (CAS). */
export type UniPiPortal = "central" | "thales" | "aristarchus" | "lefkippos";

export const PORTAL_BASE_URL: Record<UniPiPortal, string> = {
  central: UNIPI_CENTRAL_BASE_URL,
  thales: THALES_BASE_URL,
  aristarchus: ARISTARCHUS_BASE_URL,
  lefkippos: LEFKIPPOS_BASE_URL,
};

export interface SemesterMeta {
  index: number;
  label: string;
  shortLabel: string;
  labelEn: string;
  folder: string;
}

export const SEMESTERS: Record<number, SemesterMeta> = {
  1: {
    index: 1,
    label: "Α' Εξάμηνο (1ο Έτος · Χειμερινό)",
    shortLabel: "Α' Εξάμηνο",
    labelEn: "1st Semester (Year 1 · Fall)",
    folder: "Α_εξάμηνο",
  },
  2: {
    index: 2,
    label: "Β' Εξάμηνο (1ο Έτος · Εαρινό)",
    shortLabel: "Β' Εξάμηνο",
    labelEn: "2nd Semester (Year 1 · Spring)",
    folder: "Β_εξάμηνο",
  },
  3: {
    index: 3,
    label: "Γ' Εξάμηνο (2ο Έτος · Χειμερινό)",
    shortLabel: "Γ' Εξάμηνο",
    labelEn: "3rd Semester (Year 2 · Fall)",
    folder: "Γ_εξάμηνο",
  },
  4: {
    index: 4,
    label: "Δ' Εξάμηνο (2ο Έτος · Εαρινό)",
    shortLabel: "Δ' Εξάμηνο",
    labelEn: "4th Semester (Year 2 · Spring)",
    folder: "Δ_Εξάμηνο",
  },
  5: {
    index: 5,
    label: "Ε' Εξάμηνο (3ο Έτος · Χειμερινό)",
    shortLabel: "Ε' Εξάμηνο",
    labelEn: "5th Semester (Year 3 · Fall)",
    folder: "Ε_Εξάμηνο",
  },
  6: {
    index: 6,
    label: "ΣΤ' Εξάμηνο (3ο Έτος · Εαρινό)",
    shortLabel: "ΣΤ' Εξάμηνο",
    labelEn: "6th Semester (Year 3 · Spring)",
    folder: "ΣΤ_Εξάμηνο",
  },
  7: {
    index: 7,
    label: "Ζ' Εξάμηνο (4ο Έτος · Χειμερινό)",
    shortLabel: "Ζ' Εξάμηνο",
    labelEn: "7th Semester (Year 4 · Fall)",
    folder: "Ζ_Εξάμηνο",
  },
  8: {
    index: 8,
    label: "Η' Εξάμηνο (4ο Έτος · Εαρινό)",
    shortLabel: "Η' Εξάμηνο",
    labelEn: "8th Semester (Year 4 · Spring)",
    folder: "Η_Εξάμηνο",
  },
  9: {
    index: 9,
    label: "Πτυχιακές Εργασίες & Ανακοινώσεις Τμήματος",
    shortLabel: "Πτυχιακές / Γενικά",
    labelEn: "Thesis & Department Announcements",
    folder: "Πτυχιακές_Γενικά",
  },
};

/**
 * Exact semester assignment (1..8, or 9 for Thesis/Announcements) for every
 * course in the Department of Informatics at University of Piraeus, verified
 * against the official undergraduate curriculum at https://cs.unipi.gr/programma-spoudwn/
 * and the live Open eClass instances on https://thales.cs.unipi.gr & https://eclass.unipi.gr.
 */
export const CS_COURSE_SEMESTER: Record<string, number> = {
  // === Α' Εξάμηνο (1st Semester) ===
  TMA117: 1, // Ανάλυση Ι (Κ. Μανές, Ι. Τασούλας)
  TMA105: 1, // Αρχές Προγραμματισμού (C/C++) (Δ. Αποστόλου)
  TMA111: 1, // Εισαγωγή στην Επιστήμη των Υπολογιστών με Python (Κ. Πατσάκης, Γ. Γκιόκα)
  TMA108: 1, // Λογική Σχεδίαση Ψηφιακών Συστημάτων (Μ. Ψαράκης)
  TMA123: 1, // Μαθηματικά των Υπολογιστών (Ι. Τασούλας)
  TMA110: 1, // Τεχνολογίες Διαδικτύου (Χ. Δουληγέρης, Ρ. Μαυροπόδη)

  // === Β' Εξάμηνο (2nd Semester) ===
  TMA120: 2, // Ανάλυση ΙΙ (Κ. Μανές, Ι. Τασούλας)
  TMA103: 2, // Αντικειμενοστρεφής Προγραμματισμός (Ε. Αλέπης, Χ. Κούτσικας)
  TMA106: 2, // Αρχιτεκτονική Υπολογιστών (Μ. Ψαράκης)
  TMA113: 2, // Διακριτά Μαθηματικά (Ι. Τασούλας)
  TMA114: 2, // Δομές Δεδομένων (Χ. Κωνσταντόπουλος, Ι. Βενέτης)
  TMA119: 2, // Εφαρμοσμένη Άλγεβρα (Ι. Βενέτης, Ι. Τασούλας)

  // === Γ' Εξάμηνο (3rd Semester) ===
  TMB121: 3, // Αντικειμενοστρεφής Ανάπτυξη Εφαρμογών (Ε. Αλέπης)
  TMB103: 3, // Λειτουργικά Συστήματα (Ι. Βενέτης, Π. Κοτζανικολάου)
  TME132: 3, // Μαθηματικός Προγραμματισμός (Γ. Κορωνάκος)
  TMB125: 3, // Πιθανότητες και Στατιστική (Κ. Μανές, Ι. Τασούλας)
  TMB108: 3, // Στατιστική (Κ. Πατσάκης)
  ODE180: 3, // Αρχές Διοίκησης Επιχειρήσεων - Μάνατζμεντ (Α. Γαλανάκη - eclass.unipi.gr)
  TMB111: 3, // Ειδικά Θέματα Στατιστικής (Φ. Γεωργιακώδης)
  TMC114: 3, // Εφαρμογές Θεωρίας Γραφημάτων (Ι. Τασούλας)
  TMB130: 3, // Παιδαγωγικά (Α. Κοντογιάννη)
  TMB144: 3, // Δίκαιο Πληροφορικής (Α. Σινανιώτη-Μαρούδη)
  TMB135: 3, // Γαλλικά Ξένη Γλώσσα 2ο έτος (Α. Βουγιουκλίδου)
  TMA166: 3, // Γαλλικά Ξένη Γλώσσα (Α. Βουγιουκλίδου)
  INF126: 3, // Αγγλική Γλώσσα Πληροφορικής (Ε. Μαμάκου)

  // === Δ' Εξάμηνο (4th Semester) ===
  TMB101: 4, // Αλγόριθμοι (Χ. Κωνσταντόπουλος)
  TMB110: 4, // Αρχές και Εφαρμογές Σημάτων και Συστημάτων (Γ. Τσιχριντζής)
  TMB124: 4, // Αρχές και Εφαρμογές Σημάτων και Συστημάτων (Χ. Δουληγέρης)
  TMB102: 4, // Βάσεις Δεδομένων (4ο εξ.) (Ι. Θεοδωρίδης, Ρ. Μαυροπόδη)
  TMB115: 4, // Δίκτυα Υπολογιστών (Χ. Δουληγέρης, Ρ. Μαυροπόδη)
  TMB112: 4, // Διαδικτυακός Προγραμματισμός (Μ. Βίρβου)
  TMB117: 4, // Προγραμματισμός στο Διαδίκτυο και τον Παγκόσμιο Ιστό (Π. Κοτζανικολάου)
  TMA112: 4, // Προηγμένα Θέματα Διαδικτυακού Προγραμματισμού (Μ. Βίρβου)
  TMG123: 4, // Πληροφορική στην Εκπαίδευση (Κ. Χρυσαφιάδη)
  TMB105: 4, // Θεωρία Πληροφοριών και Κωδίκων (Κ. Πατσάκης)
  TMB128: 4, // Εφαρμοσμένη Συνδυαστική (Ι. Τασούλας, Κ. Μανές)
  TMB136: 4, // Εφαρμοσμένη Συνδυαστική 2024-2025 (Ε. Ψαρρά)
  TMB143: 4, // Επιχειρησιακή Στρατηγική (Ι. Πολλάλης)
  ICT106: 4, // Επιχειρησιακή Στρατηγική (Ι. Πολλάλης)
  TMB118: 4, // Ξενόγλωσση Ορολογία της Πληροφορικής (Φ. Σιβρίδου, Α. Βουγιουκλίδου)
  TMB129: 4, // Ξενόγλωσση Ορολογία της Πληροφορικής (Ε. Μαμάκου)
  TMA172: 4, // Ξενόγλωσση Ορολογία Πληροφορικής (Ε. Μαμάκου)
  TMB123: 4, // Γαλλική Ορολογία Πληροφορικής (Α. Βουγιουκλίδου)
  EBI226: 4, // Αγγλικά IV - Ορολογία Πληροφορικής (Ε. Μαμάκου)
  TMB113: 4, // Δυναμικά Συστήματα (Δ. Σωτηρόπουλος)
  TMB122: 4, // Υπολογιστική Θεωρία Αριθμών (Α. Σαπουνάκης, Κ. Μανές)
  TMB126: 4, // Υπολογιστική Θεωρία Αριθμών (Κ. Μανές)
  TMB107: 4, // Υπολογιστική Στατιστική (Φ. Γεωργιακώδης, Μ. Μαύρη)
  INF103: 4, // Επιχειρηματικότητα και Καινοτομία

  // === Ε' Εξάμηνο (5th Semester) ===
  TMC101: 5, // Αλληλεπίδραση Ανθρώπου-Υπολογιστή (Μ. Βίρβου)
  TMC100: 5, // Αναγνώριση Προτύπων (Δ. Σωτηρόπουλος, Γ. Τσιχριντζής)
  TMC106: 5, // Κρυπτογραφία (Κ. Πατσάκης)
  TMC110: 5, // Συστήματα Διαχείρισης Δεδομένων (5ο εξ.) (Ι. Θεοδωρίδης, Ν. Πελέκης)
  TMC121: 5, // Πληροφοριακά Συστήματα (Κ. Μεταξιώτης, Κ. Λιαγκούρας)
  TMC129: 5, // Επιστημονική Συγγραφή στην Εκπαίδευση (Ι. Βενέτης, Κ. Λιαγκούρας)
  TMC136: 5, // Ακαδημαϊκή Γραφή (Α. Βουγιουκλίδου)
  TMC105: 5, // Λογικός Προγραμματισμός (Θ. Παναγιωτόπουλος, Δ. Αποστόλου)
  TMC103: 5, // Προηγμένη Αρχιτεκτονική Υπολογιστών (Μ. Ψαράκης)
  TMC112: 5, // Σχεδίαση Υπολογιστικών Συστημάτων (Μ. Ψαράκης)
  TMC118: 5, // Προηγμένα Θέματα Επικοινωνιών (Δ. Βέργαδος)
  TMC123: 5, // Ανάλυση Δεδομένων (Ι. Σίσκος, Φ. Γεωργιακώδης)
  TMC124: 5, // Ειδικά Θέματα Επιχειρησιακής Έρευνας (Γ. Κορωνάκος)
  TMC125: 5, // Θεωρία Υπολογισμού (Χ. Κωνσταντόπουλος)
  TMC133: 5, // Λογισμικό Διαχείρισης Μάθησης - ΠΛΛΟΔΙΜ01 (Κ. Χρυσαφιάδη, Π. Τσάκωνας, Α. Κοντογιάννη)
  TMC137: 5, // Θεωρία Παιγνίων και Εφαρμογές (Ε. Φούντας)
  TMA100: 5, // Αντίστροφα Προβλήματα (Γ. Τσιχριντζής)
  TMC130: 5, // Γαλλικά Ξένη Γλώσσα Ειδικότητας (Α. Βουγιουκλίδου)
  INF123: 5, // Αγγλικά V (Ε. Μαμάκου)
  TMC143: 5, // Τεχνολογία Λογισμικού Βασισμένη σε Πρότυπα (Ε. Σακκόπουλος)

  // === ΣΤ' Εξάμηνο (6th Semester) ===
  TMC111: 6, // Τεχνολογία Λογισμικού (Μ. Βίρβου, Ε. Αλέπης, Κ. Χρυσαφιάδη)
  TMB109: 6, // Τεχνητή Νοημοσύνη και Έμπειρα Συστήματα (Δ. Αποστόλου)
  TMB100: 6, // Μεταγλωττιστές (Α. Πικράκης)
  TMC119: 6, // Προγραμματισμός Συστημάτων, Τηλεπικοινωνιών και Υπηρεσιών (Δ. Βέργαδος)
  TMD104: 6, // Αναλυτική Δεδομένων (6ο εξ.) (Ι. Θεοδωρίδης, Ν. Πελέκης, Α. Πικράκης)
  TMC102: 6, // Γραφικά με Υπολογιστές (Θ. Παναγιωτόπουλος, Α. Λαζαρίδης)
  TMC108: 6, // Συστήματα Πολυμέσων (Α. Πικράκης)
  TMC109: 6, // Ευφυή Συστήματα Υποστήριξης Αποφάσεων (Γ. Κορωνάκος)
  TMC113: 6, // Επεξεργασία Φυσικής Γλώσσας (Γ. Τσιχριντζής, Δ. Σωτηρόπουλος)
  TMC126: 6, // Βιοπληροφορική (Α. Πικράκης)
  TMC132: 6, // Ευφυής Αλληλεπίδραση με Κοινωνικά Δίκτυα (Δ. Σωτηρόπουλος)
  TMC139: 6, // Παράλληλος Υπολογισμός (Ι. Βενέτης)
  TMD116: 6, // Διοίκηση Ασφάλειας Συστημάτων (Ν. Πολέμη, Κ. Πατσάκης)
  TMD121: 6, // Δίκτυα Υψηλών Ταχυτήτων (Δ. Βέργαδος)
  TMD142: 6, // Διδακτική της Πληροφορικής - ΠΛΔΙΔΠΛ01 (Π. Τσάκωνας)
  TMC107: 6, // Ουρές Αναμονής (Χ. Δουληγέρης, Θ. Δασακλής)
  TMC116: 6, // Συστημική Ανάλυση (Ν. Ασημακόπουλος)
  OEP439: 6, // Αγγλικά VI (Ε. Μαμάκου)

  // === Ζ' Εξάμηνο (7th Semester) ===
  TMD131: 7, // Κατανεμημένα και Πολυεπεξεργαστικά Υπολογιστικά Συστήματα (Μ. Ψαράκης, Χ. Δουληγέρης)
  TMD112: 7, // Κατανεμημένα Συστήματα (Χ. Δουληγέρης, Σ. Μητρόπουλος)
  TMA107: 7, // Πολυεπεξεργαστικά Υπολογιστικά Συστήματα (Μ. Ψαράκης)
  TMD108: 7, // Ασφάλεια Πληροφοριακών και Κυβερνο-Φυσικών Συστημάτων (Π. Κοτζανικολάου)
  TMD105: 7, // Ανάκτηση Πληροφορίας και Αναζήτηση στον Παγκόσμιο Ιστό (Χ. Κωνσταντόπουλος)
  TMD107: 7, // Ανάκτηση Πληροφοριών (Χ. Κωνσταντόπουλος)
  TMC104: 7, // Προσομοίωση Συστημάτων (Ν. Ασημακόπουλος)
  TMD117: 7, // Εικονική Πραγματικότητα (Ε. Αλέπης, Μ. Καμήτσιος)
  TMD102: 7, // Ανάλυση Εικόνας (Γ. Τσιχριντζής, Δ. Σωτηρόπουλος)
  TMD100: 7, // Σύγχρονα Θέματα Τεχνολογίας Λογισμικού - Λογισμικό για Κινητές Συσκευές (Μ. Βίρβου, Ε. Αλέπης)
  TMC134: 7, // Αξιολόγηση Προγραμμάτων Διδασκαλίας - ΠΛΑΠΡΟΔΙΔ01 (Π. Τσάκωνας)
  INF105: 7, // Αξιολόγηση Προγραμμάτων Διδασκαλίας (Π. Τσάκωνας - eclass.unipi.gr)
  TMA169: 7, // Οχηματικά Δίκτυα Επόμενης Γενιάς (Ε. Σκόνδρας, Δ. Βέργαδος)
  TMD114: 7, // Κινητές και Ασύρματες Επικοινωνίες (Δ. Βέργαδος, Ε. Σκόνδρας)
  TMD124: 7, // Διαχείριση Γνώσης (Κ. Μεταξιώτης, Κ. Λιαγκούρας)
  TMD139: 7, // Έξυπνες Πόλεις και Διαδίκτυο των Πραγμάτων (Δ. Βέργαδος)
  TMD138: 7, // Ηλεκτρονική Μάθηση και Κοινωνικά Δίκτυα (Δ. Σωτηρόπουλος)
  TMD133: 7, // Τεχνολογίες Ανάπτυξης Ηλεκτρονικών Παιχνιδιών (Θ. Παναγιωτόπουλος)
  TMD137: 7, // Υπηρεσιοστρεφές Λογισμικό - ΠΛΥΠΛΟ01 (Ε. Σακκόπουλος)
  TMD136: 7, // Υπολογιστική Γεωμετρία (Κ. Μανές)
  TMD106: 7, // Αξιοπιστία Υπολογιστικών Συστημάτων (Μ. Ψαράκης)
  TMD126: 7, // Περιβάλλοντα Ανάπτυξης Λογισμικού (Θ. Παναγιωτόπουλος)
  TMD130: 7, // Πληροφοριακά Συστήματα στη Ναυτιλία (7ο εξ.) (Ν. Πολέμη)
  TMD151: 7, // Ενσωματωμένα Συστήματα - ΠΛΕΝΣ01 (Μ. Ψαράκης)
  TMD132: 7, // Πρακτική Άσκηση (Δ. Βέργαδος, Γ. Τσιχριντζής)

  // === Η' Εξάμηνο (8th Semester) ===
  TMA102: 8, // Ασφάλεια Δικτύων (Π. Κοτζανικολάου, Δ. Πολέμη)
  TMD128: 8, // Ηλεκτρονικό Επιχειρείν και Καινοτομία (Ν. Πολέμη, Θ. Δασακλής)
  TMD147: 8, // Πληροφοριακά Συστήματα στο Διαδίκτυο (Χ. Δουληγέρης, Α. Καραλής)
  TMD129: 8, // Διοικητική Πληροφορική (Κ. Μεταξιώτης, Κ. Λιαγκούρας)
  TMD101: 8, // Εκπαιδευτικό Λογισμικό (Μ. Βίρβου, Ε. Σακκόπουλος)
  TMD103: 8, // Επεξεργασία Σημάτων Φωνής και Ήχου (Α. Πικράκης)
  TMD113: 8, // Ευφυείς Πράκτορες (Ε. Σακκόπουλος, Μ. Καμήτσιος)
  TMA109: 8, // Συστήματα ERP/CRM (Κ. Μεταξιώτης, Κ. Λιαγκούρας)
  TMD144: 8, // Προηγμένα Θέματα Διαχείρισης Δικτύων και Κινητών Επικοινωνιών (8o) (Δ. Βέργαδος)
  TMD115: 8, // Συστήματα Διασφάλισης Ποιότητας (Ι. Σίσκος)
  TMD135: 8, // Συστήματα Διασφάλισης Ποιότητας (Γ. Κορωνάκος)
  TMD140: 8, // Τεχνολογίες Blockchain και Εφαρμογές (Α. Κοντογιάννη, Θ. Δασακλής)
  TMD146: 8, // Θέματα Επιστήμης Δεδομένων (Ι. Θεοδωρίδης, Ν. Πελέκης, Α. Πικράκης)
  TMD150: 8, // Κβαντική Υπολογιστική (Α. Παυλίδης)
  TMD152: 8, // Προγραμματισμός Υποβοηθούμενος από Τεχνητή Νοημοσύνη (Ε. Αλέπης, Ε. Σακκόπουλος)
  TMD122: 8, // Ψηφιακές Βιβλιοθήκες (Θ. Παναγιωτόπουλος)
  TMD148: 8, // Γαλλικά Ξένη Γλώσσα Ειδικότητας 4ο έτος (Α. Βουγιουκλίδου)
  TMD119: 8, // Διδακτική (Ε. Φούντας)

  // === Πτυχιακές & Γενικές Ανακοινώσεις Τμήματος (9) ===
  TMG100: 9, // Ανακοινώσεις Προπτυχιακού Πληροφορική
  INF134: 9, // Συμπληρωματικό Ερωτηματολόγιο Πρωτοετών Φοιτητών (Μητρώα P24)
};

/** Placeholder / test courses on Thales to exclude from the clean catalog. */
export const EXCLUDED_COURSE_CODES = new Set(["TMA174", "TMA173", "TMB140"]);

export interface UniPiDepartmentSpec extends DepartmentInfo {
  /** Portals the department's students are enrolled on; the first one must accept the login. */
  portals: UniPiPortal[];
  sources: Array<{
    portal: UniPiPortal;
    fc: number;
    defaultYear?: number;
    /** Sub-folders of this root that are not crawled. */
    skipFc?: number[];
  }>;
  extraCentralCourses?: Array<{
    code: string;
    publicCode: string;
    title: string;
    professor: string;
    numericId: number;
    semesterIndex: number;
  }>;
}

/**
 * University of Piraeus departments. `fc` values are faculty ROOTS on each portal (verified
 * against the public faculty trees, Nov 2026); the catalog crawler walks their sub-folders
 * (programme / semester) automatically, and falls back to the student's own faculty page on
 * eclass.unipi.gr if an id ever stops returning courses.
 */
export const UNIPI_DEPARTMENTS: UniPiDepartmentSpec[] = [
  {
    id: "cs-ug",
    name: "Τμήμα Πληροφορικής — Προπτυχιακό (Α' – Η' Εξάμηνο)",
    nameEn: "Department of Informatics — Undergraduate (Semesters 1–8)",
    portalLabel: "thales.cs.unipi.gr + eclass.unipi.gr",
    portals: ["thales", "central"],
    sources: [
      { portal: "thales", fc: 19, defaultYear: 1 },
      { portal: "thales", fc: 22, defaultYear: 2 },
      { portal: "thales", fc: 25, defaultYear: 3 },
      { portal: "thales", fc: 28, defaultYear: 4 },
      { portal: "thales", fc: 39, defaultYear: 5 },
      { portal: "thales", fc: 54, defaultYear: 5 },
      { portal: "central", fc: 41 },
    ],
    extraCentralCourses: [
      {
        code: "ODE180",
        publicCode: "ODE180",
        title: "ΑΡΧΕΣ ΔΙΟΙΚΗΣΗΣ ΕΠΙΧΕΙΡΗΣΕΩΝ - ΜΑΝΑΤΖΜΕΝΤ (ΤΜ. ΠΛΗΡΟΦΟΡΙΚΗΣ)",
        professor: "ΑΓΓΕΛΙΚΗ ΓΑΛΑΝΑΚΗ",
        numericId: 434,
        semesterIndex: 3,
      },
    ],
  },
  {
    id: "cs-pg",
    name: "Τμήμα Πληροφορικής — Μεταπτυχιακά (ΠΜΣ)",
    nameEn: "Department of Informatics — Postgraduate (MSc)",
    portalLabel: "thales.cs.unipi.gr",
    portals: ["thales", "central"],
    sources: [
      { portal: "thales", fc: 32 },
      { portal: "thales", fc: 35 },
      { portal: "thales", fc: 38 },
      { portal: "thales", fc: 44 },
      { portal: "thales", fc: 47 },
      { portal: "thales", fc: 50 },
      { portal: "thales", fc: 56 },
    ],
  },
  {
    id: "ds",
    name: "Τμήμα Ψηφιακών Συστημάτων — Προπτυχιακό",
    nameEn: "Department of Digital Systems — Undergraduate",
    portalLabel: "aristarchus.ds.unipi.gr + eclass.unipi.gr",
    // Almost every DS course lives on Aristarchus; eclass.unipi.gr only has the new DTDS courses
    portals: ["aristarchus", "central"],
    sources: [
      // fc 18 holds the retired "[ΠΑΛΑΙΟ ΜΑΘΗΜΑ]" courses that are only examined
      { portal: "aristarchus", fc: 7, skipFc: [18] },
      { portal: "central", fc: 44 },
    ],
  },
  {
    id: "ds-pg",
    name: "Τμήμα Ψηφιακών Συστημάτων — Μεταπτυχιακά (ΠΜΣ)",
    nameEn: "Department of Digital Systems — Postgraduate (MSc)",
    portalLabel: "lefkippos.ds.unipi.gr",
    portals: ["lefkippos", "central"],
    sources: [{ portal: "lefkippos", fc: 7 }],
  },
  {
    id: "ode",
    name: "Τμήμα Οργάνωσης και Διοίκησης Επιχειρήσεων",
    nameEn: "Department of Business Administration",
    portalLabel: "eclass.unipi.gr",
    portals: ["central"],
    sources: [{ portal: "central", fc: 7 }],
  },
  {
    id: "econ",
    name: "Τμήμα Οικονομικής Επιστήμης",
    nameEn: "Department of Economics",
    portalLabel: "eclass.unipi.gr",
    portals: ["central"],
    sources: [{ portal: "central", fc: 6 }],
  },
  {
    id: "fin",
    name: "Τμήμα Χρηματοοικονομικής και Τραπεζικής Διοικητικής",
    nameEn: "Department of Banking and Financial Management",
    portalLabel: "eclass.unipi.gr",
    portals: ["central"],
    sources: [{ portal: "central", fc: 9 }],
  },
  {
    id: "stat",
    name: "Τμήμα Στατιστικής και Ασφαλιστικής Επιστήμης",
    nameEn: "Department of Statistics and Insurance Science",
    portalLabel: "eclass.unipi.gr",
    portals: ["central"],
    sources: [{ portal: "central", fc: 8 }],
  },
  {
    id: "bdt",
    name: "Τμήμα Βιομηχανικής Διοίκησης και Τεχνολογίας",
    nameEn: "Department of Industrial Management and Technology",
    portalLabel: "eclass.unipi.gr",
    portals: ["central"],
    sources: [{ portal: "central", fc: 10 }],
  },
  {
    id: "nas",
    name: "Τμήμα Ναυτιλιακών Σπουδών",
    nameEn: "Department of Maritime Studies",
    portalLabel: "eclass.unipi.gr",
    portals: ["central"],
    sources: [{ portal: "central", fc: 11 }],
  },
  {
    id: "des",
    name: "Τμήμα Διεθνών και Ευρωπαϊκών Σπουδών",
    nameEn: "Department of International and European Studies",
    portalLabel: "eclass.unipi.gr",
    portals: ["central"],
    sources: [{ portal: "central", fc: 14 }],
  },
  {
    id: "tou",
    name: "Τμήμα Τουριστικών Σπουδών",
    nameEn: "Department of Tourism Studies",
    portalLabel: "eclass.unipi.gr",
    portals: ["central"],
    sources: [{ portal: "central", fc: 58 }],
  },
];

/**
 * Resolves the semester metadata (`1..8` or `9`) for a course given its code,
 * title, and optional Thales year hint (`1..4`).
 */
export function resolveSemesterForCourse(
  code: string,
  title: string,
  defaultYear?: number,
): SemesterMeta {
  const upperCode = code.trim().toUpperCase();
  if (CS_COURSE_SEMESTER[upperCode]) {
    return SEMESTERS[CS_COURSE_SEMESTER[upperCode]];
  }
  if (/τεχνολογία\s+λογισμικού\s+βασισμένη\s+σε\s+πρότυπα/i.test(title)) {
    return SEMESTERS[5];
  }
  if (upperCode.startsWith("TMK") || upperCode.startsWith("TMG100") || /πτυχιακ|ανακοινώσεις/i.test(title)) {
    return SEMESTERS[9];
  }

  // Check explicit semester mention in title, e.g. "(5ο εξ.)", "(6ο εξ.)", "(8o)"
  const explicitSem = title.match(/\(([1-8])\s*[οo]\s*(?:εξ|ex)?/i) || title.match(/([1-8])ο\s*εξάμηνο/i);
  if (explicitSem) {
    const idx = Number(explicitSem[1]);
    if (SEMESTERS[idx]) return SEMESTERS[idx];
  }

  // Roman numerals / English levels in title
  if (/\bVI\b/.test(title)) return SEMESTERS[6];
  if (/\bV\b/.test(title)) return SEMESTERS[5];
  if (/\bIV\b/.test(title)) return SEMESTERS[4];
  if (/\bIII\b/.test(title)) return SEMESTERS[3];
  if (/\bII\b|\bΙΙ\b/.test(title) && defaultYear === 1) return SEMESTERS[2];
  if (/\bI\b|\bΙ\b/.test(title) && defaultYear === 1) return SEMESTERS[1];

  if (/εαριν/i.test(title)) {
    if (defaultYear === 1) return SEMESTERS[2];
    if (defaultYear === 2) return SEMESTERS[4];
    if (defaultYear === 3) return SEMESTERS[6];
    if (defaultYear === 4) return SEMESTERS[8];
  }

  if (defaultYear === 1) return SEMESTERS[1];
  if (defaultYear === 2) return SEMESTERS[3];
  if (defaultYear === 3) return SEMESTERS[5];
  if (defaultYear === 4) return SEMESTERS[7];
  if (defaultYear === 5) return SEMESTERS[9];

  // Fallback by prefix on Thales
  if (upperCode.startsWith("TMA")) return SEMESTERS[1];
  if (upperCode.startsWith("TMB")) return SEMESTERS[3];
  if (upperCode.startsWith("TMC")) return SEMESTERS[5];
  if (upperCode.startsWith("TMD")) return SEMESTERS[7];

  return SEMESTERS[1];
}

/** Digital Systems MSc course code prefixes on Lefkippos. */
const LEFKIPPOS_PREFIXES = ["CLIMATE_ICT", "LAWICT", "AI_IIT", "DSERV", "ELEARN", "DCOMMS", "SEC"];

/**
 * Best guess of the portal a course code lives on, used before the course has been seen in a
 * listing (listings record the real portal of every course they return).
 */
export function resolveUniPiPortalForCourse(courseCode: string): UniPiPortal {
  const c = courseCode.trim().toUpperCase();
  if (c.startsWith("DS-") || /^DS\d/.test(c)) return "aristarchus";
  if (LEFKIPPOS_PREFIXES.some((p) => c.startsWith(p))) return "lefkippos";
  if (
    c.startsWith("TM") ||
    c.startsWith("CDS") ||
    c.startsWith("DCSCIOT") ||
    c.startsWith("PLH") ||
    c.startsWith("ΠΛ")
  ) {
    return "thales";
  }
  return "central";
}

/* ------------------------------------------------------------------ */
/* Department detection from the CAS username                        */
/* ------------------------------------------------------------------ */

/**
 * Automatically resolves the University of Piraeus department ID from the
 * student's CAS username (e.g. `p24046` -> `cs-ug`).
 */
export function detectUniPiDepartmentFromUsername(rawUsername: string): string {
  const u = rawUsername.trim().toLowerCase().split("@")[0];
  if (/^(psp|mp|msc|pms)\d+/i.test(u)) return "cs-pg";
  if (/^p\d+/i.test(u)) return "cs-ug";
  if (/^e\d+/i.test(u)) return "ds";
  if (/^m\d+/i.test(u)) return "ode";
  if (/^o\d+/i.test(u)) return "econ";
  if (/^x\d+/i.test(u)) return "fin";
  if (/^s\d+/i.test(u)) return "stat";
  if (/^b\d+/i.test(u)) return "bdt";
  if (/^n\d+/i.test(u)) return "nas";
  if (/^d\d+/i.test(u)) return "des";
  if (/^t\d+/i.test(u)) return "tou";
  return "cs-ug";
}

/* ------------------------------------------------------------------ */
/* Smart Academic-Year Filtering (Assignments, Documents, News)        */
/* ------------------------------------------------------------------ */

export function getCurrentAcademicYearBounds(now = new Date()): {
  startYear: number;
  endYear: number;
  startMs: number;
  label: string;
} {
  const year = now.getFullYear();
  const month = now.getMonth(); // 0 = Jan .. 8 = Sep
  const startYear = month >= 7 ? year : year - 1;
  const endYear = startYear + 1;
  const startMs = new Date(startYear, 8, 25, 0, 0, 0).getTime(); // Sep 25 of startYear (after September resit exams)
  return { startYear, endYear, startMs, label: `${startYear}-${endYear}` };
}

/**
 * Returns true if `text` explicitly mentions a past academic year (e.g. "2024-2025",
 * "2025_2026", "fall2025", "Διαφάνειες μαθήματος 2025", "Σεπτέμβριος 2025") and does
 * NOT mention the current academic year (e.g. "2026-2027", "2026_2027", "2026").
 */
export function hasPastAcademicYearTag(text: string, now = new Date()): boolean {
  const { startYear, endYear } = getCurrentAcademicYearBounds(now);
  const s = text.toLowerCase();

  // If it explicitly mentions the current academic year range (e.g. 2026-2027, 2026_2027, 2026-27, 2026-2206 typo on eClass), keep it!
  const curRangeRe = new RegExp(
    `\\b${startYear}\\s*[-_/]\\s*(?:${endYear}|${String(endYear).slice(-2)}|2206)\\b`,
    "i",
  );
  if (curRangeRe.test(s)) return false;

  // Check explicit academic year range YYYY-YYYY or YYYY_YYYY or YYYY-YY
  const rangeMatches = [...s.matchAll(/\b(20\d{2})\s*[-_/]\s*(20\d{2}|\d{2})\b/g)];
  for (const m of rangeMatches) {
    const y1 = Number(m[1]);
    if (y1 < startYear) return true;
  }

  // Check short academic year range like "20-21", "21-22", "22-23", "23-24", "24-25", "25-26"
  const shortMatches = [...s.matchAll(/(?:^|[_\s(-])(1[89]|2[0-5])\s*[-_]\s*(19|2[0-6])(?:$|[_\s).])/g)];
  if (shortMatches.length > 0) return true;

  // Check standalone 4-digit year in contextual phrases (e.g. "Διαφάνειες μαθήματος 2025", "fall2025", "εργασίες 2024", "ΕΞΕΤΑΣΤΙΚΗ 2020")
  const standaloneYears = [...s.matchAll(/(?:201[5-9]|202[0-9])/g)].map((m) => Number(m[0]));
  if (standaloneYears.length > 0) {
    const maxYear = Math.max(...standaloneYears);
    if (maxYear < startYear) {
      // Ignore software version names like "Visual Studio 2022" or textbook editions like "4th Ed 2008"
      if (!/visual\s*studio|office|windows|sql\s*server|\bed\b|edition|έκδοση/i.test(s)) {
        return true;
      }
    }
  }

  if (/\bpast\s+exams\b|παλι[αέ]ς?\s+εξετ|παλαι[αέ]ς?\s+εργ/i.test(s)) {
    return true;
  }

  return false;
}

/**
 * True for catalog entries that are exam rooms of a past exam period, e.g.
 * "ΕΞΕΤΑΣΗ ΦΕΒΡ2024" or "[ΨΣ-507] … - Εξετάσεις Φεβρ.24". Current exam rooms stay visible.
 */
export function isPastExamRoom(title: string, now = new Date()): boolean {
  const t = title
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "");
  if (!/εξετασ|εξεταση|exam/.test(t)) return false;
  if (hasPastAcademicYearTag(title, now)) return true;
  const { startYear } = getCurrentAcademicYearBounds(now);
  const m = t.match(/(?:ιαν|φεβ|μαρ|απρ|μαι|ιουν|ιουλ|αυγ|σεπ|οκτ|νοε|δεκ|jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-zα-ω]*\.?\s*'?(\d{2})(?![\d/])/);
  return Boolean(m && Number(m[1]) + 2000 < startYear);
}

/**
 * Filters raw eClass assignments so only current academic-year / active assignments appear.
 */
export function filterCurrentAcademicYearAssignments(
  assignments: Assignment[],
  now = new Date(),
): Assignment[] {
  const { startMs } = getCurrentAcademicYearBounds(now);
  const nowMs = now.getTime();

  return assignments.filter((a) => {
    const t = a.title.trim();
    if (hasPastAcademicYearTag(t, now)) return false;

    // Exclude past September / Embólimi / Epi Ptychio exam-period slots whose deadline has already passed or has no future deadline
    const isExamSlot = /σεπτ[εέ]μβρ|εμβ[οό]λιμ|επ[ιί]\s*πτυχ[ιί][ωο]/i.test(t);
    if (a.deadline) {
      const dMs = new Date(a.deadline).getTime();
      if (!Number.isNaN(dMs)) {
        // Any assignment with a deadline before the start of the current academic year is from a previous year
        if (dMs < startMs) return false;
        // If it's a September/Embolimi exam slot and its deadline has already passed, hide it
        if (isExamSlot && dMs < nowMs) return false;
      }
    } else if (isExamSlot) {
      // Exam-slot assignment with no active deadline
      return false;
    }

    return true;
  });
}

/**
 * Filters course documents so files/folders from previous academic years (e.g. 2024-2025 projects,
 * 2025-2026 projects, old schedules/announcements) are hidden while keeping current-year projects
 * and timeless lecture material.
 */
export function filterCurrentAcademicYearDocs(nodes: DocNode[], now = new Date()): DocNode[] {
  const { startMs } = getCurrentAcademicYearBounds(now);

  return nodes.filter((node) => {
    const name = node.name.trim();
    if (hasPastAcademicYearTag(name, now)) return false;

    // If the file is an assignment/project/exam/schedule/announcement item uploaded in a previous academic year, filter it out
    const isTransientAcademicItem =
      /(?:^|[^a-zα-ω])(εργασ[ιί]α|εργασ[ιί]ες|ergasia|project|εκφ[ωώ]νηση|παρουσι[αά]σεις\s+εργασι|χρονοδι[αά]γραμμα|βαθμολ[οό]γιο|πρ[οό]γραμμα|ανακο[ιί]νωση|anakoinosi|εμβ[οό]λιμη|εξεταστικ[ηή]|υποδοχ[ηή]|προκ[ηή]ρυξη|αποτελ[εέ]σμ|προσωριν[αά]|erasmus|aiesec|poster)(?:$|[^a-zα-ω])/i.test(
        name,
      );

    if (isTransientAcademicItem && node.date) {
      const dMs = new Date(node.date).getTime();
      if (!Number.isNaN(dMs) && dMs < startMs) {
        return false;
      }
    }

    return true;
  });
}

/**
 * Filters announcements to the current academic year so stale announcements from previous years do not clutter the feed or AI.
 */
export function filterCurrentAcademicYearAnnouncements(
  announcements: Announcement[],
  now = new Date(),
): Announcement[] {
  const { startMs } = getCurrentAcademicYearBounds(now);
  return announcements.filter((a) => {
    const dMs = new Date(a.date).getTime();
    if (!Number.isNaN(dMs) && dMs < startMs) return false;
    if (hasPastAcademicYearTag(a.title, now) && (Number.isNaN(dMs) || dMs < startMs)) return false;
    return true;
  });
}

/* ------------------------------------------------------------------ */
/* Course titles with the semester and code inline                     */
/* ------------------------------------------------------------------ */

const BRACKET_SEMESTER: Record<string, number> = {
  Α: 1, A: 1, Β: 2, B: 2, Γ: 3, Δ: 4, Ε: 5, E: 5, ΣΤ: 6, Ζ: 7, Z: 7, Η: 8, H: 8,
};

/**
 * Digital Systems portals name courses like "[Α] - (ΨΣ-014) - Λογική και Λογικός Προγραμματισμός".
 * Splits that into the plain title, the curriculum code and the semester. Titles that do not
 * follow the pattern come back unchanged.
 */
export function splitCourseTitle(raw: string): { title: string; curriculumCode?: string; semesterIndex?: number } {
  const m = raw.trim().match(/^(?:[[(]\s*([^[\]()]{1,3}?)\s*[\])]\s*[-–]?\s*)?(?:\(([^()]{2,24})\)\s*[-–]?\s*)?(.+)$/);
  if (!m) return { title: raw };
  const semesterIndex = m[1] ? BRACKET_SEMESTER[m[1].toUpperCase()] : undefined;
  const curriculumCode = m[2] && /\d/.test(m[2]) ? m[2].trim() : undefined;
  if (semesterIndex === undefined && !curriculumCode) return { title: raw };
  // A parenthesis that is not a code ("(Lab)") stays part of the title
  const title = (m[2] && !curriculumCode ? `(${m[2]}) ${m[3]}` : m[3]).trim();
  return { title, curriculumCode, semesterIndex };
}
