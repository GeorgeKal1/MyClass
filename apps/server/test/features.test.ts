import { deflateRawSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import { prepareDocumentForAi, readZipEntries } from "../src/doctext.js";
import {
  isFirewallBlock,
  isLoggedOutPage,
  parseAssignmentDetailHtml,
  parseAutoPostForm,
  parseCasLoginForm,
  parseCatalogHtml,
  parseCourseTools,
  semesterFromText,
} from "../src/eclass/parsers.js";

// Trimmed from the live eclass.unipi.gr (Open eClass 4.2.1) faculty page of Digital Systems (fc=13)
const FACULTY_PAGE = `
<div id="main"><ul class='list-group list-group-flush'>
  <li class="list-group-item list-group-item-action d-flex">
    <a href='/modules/auth/courses.php?fc=53'>Πανεπιστήμιο Πειραιώς</a> »
    <a href='/modules/auth/courses.php?fc=57'>Τεχνολογιών Πληροφορικής και Επικοινωνιών</a> » Τμήμα Ψηφιακών Συστημάτων
  </li>
  <li class='list-group-item element'><div class='table_td_header'><div class='d-flex'>
    <a class='TextBold' href='courses.php?fc=44'>Προπτυχιακό</a><span>(DTDS)</span></div>
    <div class='vsmall-text text-end'>21&nbsp;διαθέσιμα μαθήματα</div></div></li>
  <li class='list-group-item element'><div class='table_td_header'><div class='d-flex'>
    <a class='TextBold' href='courses.php?fc=45'>Μεταπτυχιακό</a></div></div></li>
  <li class='list-group-item element'>
    <input type='checkbox' name='selectCourse[]' value='901' checked>
    <a class='TextBold' href='https://eclass.unipi.gr/courses/DTDS101/'>Δομές Δεδομένων</a> <small>(ΨΣ-101)</small>
    <small class='vsmall-text'>Α. Καθηγητής</small>
  </li>
</ul></div>`;

describe("catalog faculty tree", () => {
  it("separates sub-faculties, breadcrumb ancestors and real courses", () => {
    const p = parseCatalogHtml(FACULTY_PAGE);
    expect(p.childFaculties).toEqual([
      { fc: 44, name: "Προπτυχιακό" },
      { fc: 45, name: "Μεταπτυχιακό" },
    ]);
    expect(p.ancestorFaculties.map((f) => f.fc)).toEqual([53, 57]);
    expect(p.currentFacultyName).toBe("Τμήμα Ψηφιακών Συστημάτων");
    expect(p.courses).toHaveLength(1);
    expect(p.courses[0]).toMatchObject({ code: "DTDS101", title: "Δομές Δεδομένων", numericId: 901, enrolled: true });
  });
});

describe("session detection", () => {
  it("recognises login pages with either quote style and the mobile API's EXPIRED answer", () => {
    expect(isLoggedOutPage("https://x.gr/main/login_form.php", "")).toBe(true);
    expect(isLoggedOutPage("https://x.gr/", "<input name='uname'><input name='pass' type='password'>")).toBe(true);
    expect(isLoggedOutPage("https://x.gr/", '<div class="jumbotron-login"></div>')).toBe(true);
    expect(isLoggedOutPage("https://x.gr/modules/mobile/mcourses.php", "EXPIRED")).toBe(true);
    expect(isLoggedOutPage("https://x.gr/main/portfolio.php", "<div class='card'>My courses</div>")).toBe(false);
  });

  it("detects WAF block pages", () => {
    expect(isFirewallBlock(403, "<h1>Web Application Firewall</h1>This transfer is blocked")).toBe(true);
    expect(isFirewallBlock(200, "Web Application Firewall")).toBe(false);
  });
});

describe("SSO forms", () => {
  it("finds custom username/password field names (Shibboleth j_username)", () => {
    const spec = parseCasLoginForm(
      `<form action="/idp/profile/SAML2/Redirect/SSO?execution=e1s1" method="post">
        <input type="text" name="j_username"><input type="password" name="j_password">
        <input type="hidden" name="csrf_token" value="abc"></form>`,
      "https://idp.example.gr/idp/profile/SAML2/Redirect/SSO?execution=e1s1",
    );
    expect(spec?.userField).toBe("j_username");
    expect(spec?.passField).toBe("j_password");
    expect(spec?.fields.csrf_token).toBe("abc");
  });

  it("detects SAML auto-post hand-off forms", () => {
    const spec = parseAutoPostForm(
      `<body onload="document.forms[0].submit()"><form action="https://eclass.example.gr/Shibboleth.sso/SAML2/POST" method="post">
        <input type="hidden" name="RelayState" value="r"/><input type="hidden" name="SAMLResponse" value="PHNhbWw+"/></form></body>`,
      "https://idp.example.gr/idp/profile/SAML2/Redirect/SSO",
    );
    expect(spec?.actionUrl).toBe("https://eclass.example.gr/Shibboleth.sso/SAML2/POST");
    expect(spec?.fields.SAMLResponse).toBe("PHNhbWw+");
    expect(parseAutoPostForm("<form><input type='password' name='p'></form>", "https://x.gr/")).toBeNull();
  });
});

describe("course tools & assignments", () => {
  it("lists course tools from the course home menu", () => {
    const tools = parseCourseTools(
      `<a href="/modules/announcements/index.php?course=DTDS101">Ανακοινώσεις</a>
       <a href="/modules/document/index.php?course=DTDS101">Έγγραφα</a>
       <a href="/modules/exercise/index.php?course=DTDS101">Ασκήσεις</a>
       <a href="/modules/exercise/index.php?course=DTDS101&amp;eid=5">Κουίζ 1</a>
       <a href="/modules/course_info/index.php?course=DTDS101">Διαχείριση</a>
       <a href="/modules/forum/index.php?course=OTHER1">Άλλο μάθημα</a>`,
      "https://eclass.unipi.gr/courses/DTDS101/",
      "DTDS101",
    );
    expect(tools.map((t) => t.id)).toEqual(["announcements", "document", "exercise"]);
    expect(tools[2].url).toBe("https://eclass.unipi.gr/modules/exercise/index.php?course=DTDS101");
  });

  it("parses the student submission form of an assignment", () => {
    const detail = parseAssignmentDetailHtml(
      `<div id="main">
        <div class="card"><div class="card-body"><p>Υλοποιήστε μια λίστα.</p>
          <a href="index.php?course=DTDS101&get=1&id=11">ekfonisi.pdf</a></div></div>
        <form id="submit_assignment_form" enctype="multipart/form-data" action="index.php?course=DTDS101" method="post">
          <input type="hidden" name="id" value="11">
          <label for="userfile">Μέγιστος αριθμός αρχείων: 3</label><div id="uppy"></div>
          <textarea name="stud_comments"></textarea>
          <input type="hidden" name="work_submit" value="true">
        </form></div>`,
      "https://eclass.unipi.gr/modules/work/index.php?course=DTDS101&id=11",
    );
    expect(detail.canSubmit).toBe(true);
    expect(detail.submissionType).toBe("file");
    expect(detail.maxFiles).toBe(3);
    expect(detail.hiddenFields).toEqual({ id: "11" });
    expect(detail.formAction).toBe("https://eclass.unipi.gr/modules/work/index.php?course=DTDS101");
    expect(detail.descriptionHtml).toContain("Υλοποιήστε");
    expect(detail.attachments[0]).toMatchObject({ name: "ekfonisi.pdf" });
  });

  it("reports closed assignments as not submittable", () => {
    const detail = parseAssignmentDetailHtml(`<div id="main"><div class="card"><div class="card-body">Έληξε</div></div></div>`, "https://x.gr/");
    expect(detail.canSubmit).toBe(false);
    expect(detail.submissionType).toBe("none");
  });
});

describe("semesterFromText", () => {
  it.each([
    ["Α' Εξάμηνο", 1],
    ["5ο εξάμηνο", 5],
    ["ΣΤ΄ Εξάμηνο", 6],
    ["Semester 3", 3],
    ["Προπτυχιακό", undefined],
  ])("%s -> %s", (text, expected) => {
    expect(semesterFromText(text)).toBe(expected);
  });
});

/** Builds a minimal one-entry deflated zip, enough to exercise the central-directory reader. */
function makeZip(name: string, content: string): Buffer {
  const data = Buffer.from(content, "utf8");
  const comp = deflateRawSync(data);
  const nameBuf = Buffer.from(name, "utf8");
  const local = Buffer.alloc(30);
  local.writeUInt32LE(0x04034b50, 0);
  local.writeUInt16LE(8, 8);
  local.writeUInt32LE(comp.length, 18);
  local.writeUInt32LE(data.length, 22);
  local.writeUInt16LE(nameBuf.length, 26);
  const central = Buffer.alloc(46);
  central.writeUInt32LE(0x02014b50, 0);
  central.writeUInt16LE(8, 10);
  central.writeUInt32LE(comp.length, 20);
  central.writeUInt32LE(data.length, 24);
  central.writeUInt16LE(nameBuf.length, 28);
  central.writeUInt32LE(0, 42);
  const cdOffset = local.length + nameBuf.length + comp.length;
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(1, 8);
  eocd.writeUInt16LE(1, 10);
  eocd.writeUInt32LE(central.length + nameBuf.length, 12);
  eocd.writeUInt32LE(cdOffset, 16);
  return Buffer.concat([local, nameBuf, comp, central, nameBuf, eocd]);
}

describe("document preparation for AI summaries", () => {
  it("extracts paragraphs from a .docx", () => {
    const zip = makeZip("word/document.xml", "<w:body><w:p><w:t>Πρώτη παράγραφος</w:t></w:p><w:p><w:t>Δεύτερη</w:t></w:p></w:body>");
    expect(readZipEntries(zip, () => true).size).toBe(1);
    const prepared = prepareDocumentForAi("ergasia.docx", "application/octet-stream", zip);
    expect(prepared).toEqual({ kind: "text", text: "Πρώτη παράγραφος\nΔεύτερη" });
  });

  it("sends PDFs inline and rejects archives", () => {
    expect(prepareDocumentForAi("a.pdf", "application/pdf", Buffer.from("%PDF")).kind).toBe("inline");
    expect(prepareDocumentForAi("a.zip", "application/zip", Buffer.from("PK")).kind).toBe("unsupported");
  });
});
