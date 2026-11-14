import { describe, expect, it } from "vitest";
import {
  parseAnnouncementsAjax,
  parseAssignmentsHtml,
  parseCasLoginForm,
  parseCatalogHtml,
  parseDocumentsHtml,
  parseEclassDate,
  parseIdentityXml,
  parseInboxAjax,
  parseMyCoursesHtml,
  parseUserDisplayName,
} from "../src/eclass/parsers.js";

describe("Open eClass 4.x parsers", () => {
  it("extracts CAS login form action and hidden execution token (UniPi SSO)", () => {
    const html = `
      <form method="post" id="fm1" action="login">
        <input id="username" name="username" type="text" value=""/>
        <input id="password" name="password" type="password" value=""/>
        <input type="hidden" name="execution" value="exec-token-123"/>
        <input type="hidden" name="_eventId" value="submit"/>
        <button id="loginButton" name="submit" type="submit">Login</button>
      </form>
    `;
    const spec = parseCasLoginForm(
      html,
      "https://sso.unipi.gr/login?service=https%3A%2F%2Feclass.unipi.gr%2Fmodules%2Fauth%2Fcas.php",
    );
    expect(spec).not.toBeNull();
    expect(spec?.actionUrl).toBe("https://sso.unipi.gr/login");
    expect(spec?.fields.execution).toBe("exec-token-123");
    expect(spec?.fields._eventId).toBe("submit");
  });

  it("parses midentity.php XML for UniPi eClass 4.2.1", () => {
    const xml = `<?xml version="1.0" encoding="utf-8"?>
      <identity>
        <institute name="Πανεπιστήμιο Πειραιώς" url="https://www.unipi.gr"/>
        <platform name="E-class Πανεπιστημίου Πειραιώς" version="4.2.1"/>
        <auth title="Σύνδεση με cas" url="https://eclass.unipi.gr/modules/auth/cas.php?next=/modules/mobile/mtoken.php"/>
      </identity>`;
    const parsed = parseIdentityXml(xml, "https://eclass.unipi.gr");
    expect(parsed.version).toBe("4.2.1");
    expect(parsed.casUrl).toBe("https://eclass.unipi.gr/modules/auth/cas.php?next=/modules/mobile/mtoken.php");
  });

  it("parses my_courses.php cards and unregcours.php modal IDs", () => {
    const html = `
      <div class='col cardCourse1'>
        <div class='card h-100'>
          <div class='card-header'><a href='https://thales.cs.unipi.gr/courses/TMC106/'>ΚΡΥΠΤΟΓΡΑΦΙΑ</a></div>
          <div class='card-body'>
            <div class='card-text'><p>Κωδικός:</p><p>TMC106</p></div>
            <div class='card-text'><p>Διδάσκων:</p><p>Κωνσταντίνος Πατσάκης</p></div>
          </div>
          <div class='card-footer'>
            <button data-bs-toggle='modal' data-bs-target='#exampleModal34'>Απεγγραφή</button>
          </div>
        </div>
      </div>
      <div class='modal fade' id='exampleModal34'>
        <form method='post' action='/main/unregcours.php?u=7651&amp;cid=34'></form>
      </div>
    `;
    const res = parseMyCoursesHtml(html);
    expect(res.uid).toBe(7651);
    expect(res.courses).toHaveLength(1);
    expect(res.courses[0]).toMatchObject({
      code: "TMC106",
      title: "ΚΡΥΠΤΟΓΡΑΦΙΑ",
      publicCode: "TMC106",
      professor: "Κωνσταντίνος Πατσάκης",
      numericId: 34,
      enrolled: true,
    });
  });

  it("parses DataTables announcements JSON and relative/2-digit dates", () => {
    const list = parseAnnouncementsAjax(
      {
        aaData: [
          {
            "0": `<div class='table_td'>
                    <div class='table_td_header clearfix'>
                      <a href='/modules/announcements/index.php?course=TMC101&an_id=901'>Διάλεξη Πέμπτης 12/11</a>
                    </div>
                    <small class='text-grey'>ΑΛΛΗΛΕΠΙΔΡΑΣΗ ΑΝΘΡΩΠΟΥ-ΥΠΟΛΟΓΙΣΤΗ</small>
                    <div class='table_td_body' data-id='901' data-course-code='TMC101'><p>Κανονικά η διάλεξη</p></div>
                  </div>`,
            "1": "χθες - 7:47 μ.μ.",
          },
        ],
      },
      "https://thales.cs.unipi.gr",
    );
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({
      id: "TMC101:901",
      courseCode: "TMC101",
      courseTitle: "ΑΛΛΗΛΕΠΙΔΡΑΣΗ ΑΝΘΡΩΠΟΥ-ΥΠΟΛΟΓΙΣΤΗ",
      title: "Διάλεξη Πέμπτης 12/11",
      contentText: "Κανονικά η διάλεξη",
    });

    const d2012 = parseEclassDate("29/10/12, 10:19 π.μ.");
    expect(new Date(d2012).getFullYear()).toBe(2012);
    expect(new Date(d2012).getMonth()).toBe(9);
  });

  it("parses documents table and root zip download link", () => {
    const html = `
      <div><a href="/modules/document/index.php?course=TMA117&amp;download=ROOTREF"><i class="fa-download"></i></a></div>
      <table id="document_table">
        <tbody>
          <tr class="visible">
            <td class="checkbox_td"><input type="checkbox" isDir="1" filepath="/lectures" cbid="1"/></td>
            <td class="fileURL-th">
              <input type="hidden" value="/modules/document/index.php?course=TMA117&amp;download=DIRREF"/>
              <a class="fileURL-link" href="/modules/document/index.php?course=TMA117&amp;openDir=/lectures">Σημειώσεις</a>
            </td>
            <td></td>
            <td>13-11-2026</td>
            <td></td>
          </tr>
          <tr class="visible">
            <td class="checkbox_td"><input type="checkbox" isDir="0" filepath="/Guide.pdf" cbid="2"/></td>
            <td class="fileURL-th">
              <input type="hidden" value="/modules/document/index.php?course=TMA117&amp;download=FILEREF"/>
              <a class="fileModal" href="/modules/document/file.php/TMA117/Guide.pdf">Guide.pdf</a>
            </td>
            <td>420 KB</td>
            <td>12-11-2026</td>
            <td></td>
          </tr>
        </tbody>
      </table>
    `;
    const parsed = parseDocumentsHtml(html, "https://thales.cs.unipi.gr/modules/document/index.php?course=TMA117");
    expect(parsed.dirZipUrl).toBe("https://thales.cs.unipi.gr/modules/document/index.php?course=TMA117&download=ROOTREF");
    expect(parsed.nodes).toHaveLength(2);
    expect(parsed.nodes[0]).toMatchObject({ path: "/lectures", name: "Σημειώσεις", isDir: true });
    expect(parsed.nodes[1]).toMatchObject({ path: "/Guide.pdf", name: "Guide.pdf", isDir: false, size: 420_000 });
  });

  it("parses student assignments table", () => {
    const html = `
      <table id="assignment_table_TMC106" class="table-default">
        <tbody>
          <tr>
            <td><a href="/modules/work/index.php?course=TMC106&amp;id=7">RSA Implementation</a></td>
            <td>27-11-2026 23:55<div><small>14 ημέρες</small></div></td>
            <td><i class="fa-regular fa-hourglass-half"></i></td>
            <td>-</td>
          </tr>
        </tbody>
      </table>
    `;
    const asg = parseAssignmentsHtml(html, "https://thales.cs.unipi.gr/modules/work/index.php", "TMC106", "Κρυπτογραφία");
    expect(asg).toHaveLength(1);
    expect(asg[0]).toMatchObject({
      id: "TMC106:7",
      title: "RSA Implementation",
      submitted: false,
    });
  });

  it("parses inbox AJAX rows, catalog real codes (via info_course.php?c=), and displayName", () => {
    const msgs = parseInboxAjax(
      {
        aaData: [
          {
            DT_RowId: 43035,
            "0": `<i class='fa fa-envelope'></i><strong><a href='inbox.php?mid=43035'>Ερωτηματολόγιο</a></strong>`,
            "1": `<a href='index.php?course=INF134'>Μητρώα P24</a>`,
            "2": `<a class="outtabs" href="/main/display_profile.php?id=99">ΠΕΡΑΝΤΩΝΑΚΗ ΕΙΡΗΝΗ</a>`,
            "3": `27-11-2024`,
          },
        ],
      },
      "https://eclass.unipi.gr",
    );
    expect(msgs).toHaveLength(1);
    expect(msgs[0]).toMatchObject({
      id: "43035",
      subject: "Ερωτηματολόγιο",
      sender: "ΠΕΡΑΝΤΩΝΑΚΗ ΕΙΡΗΝΗ",
      read: false,
      courseCode: "INF134",
    });

    const cat = parseCatalogHtml(`
      <ul>
        <li class="list-group-item element">
          <input type="checkbox" name="selectCourse[]" value="329" disabled/>
          <input type="hidden" name="changeCourse[]" value="329"/>
          <span class="TextBold">ΑΞΙΟΛΟΓΗΣΗ ΠΡΟΓΡΑΜΜΑΤΩΝ ΔΙΔΑΣΚΑΛΙΑΣ</span><small>(ΠΛΑΠΡΟΔΙΔ01)</small>
          <div><small class="vsmall-text">Παναγιώτης Τσάκωνας</small></div>
          <a href="/modules/auth/info_course.php?c=TMC134">Info</a>
        </li>
      </ul>
    `);
    expect(cat.courses).toHaveLength(1);
    expect(cat.courses[0]).toMatchObject({
      code: "TMC134",
      publicCode: "ΠΛΑΠΡΟΔΙΔ01",
      title: "ΑΞΙΟΛΟΓΗΣΗ ΠΡΟΓΡΑΜΜΑΤΩΝ ΔΙΔΑΣΚΑΛΙΑΣ",
      professor: "Παναγιώτης Τσάκωνας",
      numericId: 329,
      enrolled: false,
      locked: true,
    });

    const name = parseUserDisplayName(`
      <nav><a href="/main/profile/display_profile.php">Το προφίλ μου</a></nav>
      <h4 class="username-text">ΕΦΡΑΙΜ ΓΕΩΡΓΙΟΣ ΚΑΛΛΙΟΝΤΖΗΣ</h4>
    `);
    expect(name).toBe("ΕΦΡΑΙΜ ΓΕΩΡΓΙΟΣ ΚΑΛΛΙΟΝΤΖΗΣ");
  });
});
