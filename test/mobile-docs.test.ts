import { describe, expect, test } from "bun:test";
import { homedir } from "os";
import { join } from "path";
import { buildSets, countTbd, idOf, mount, pageFile, setLabel, tbdLines } from "../src/mobile/features/docs";

describe("docs pack", () => {
  const H = homedir();
  const set = join(H, "artron/demo/Acme/docs");
  const tree: Record<string, { name: string; size: number; mtime: number; dir: boolean }[]> = {
    [join(set, "WP18 Software User Documentation")]: [
      { name: "ACME_SUD_V1.1.docx", size: 2048, mtime: 200, dir: false },
      { name: "~$ACME_SUD_V1.1.docx", size: 1, mtime: 300, dir: false },      // Word lock file
      { name: ".DS_Store", size: 1, mtime: 300, dir: false },
      { name: "img", size: 0, mtime: 0, dir: true },
    ],
    [join(set, "WP18 Software User Documentation", "img")]: [{ name: "shot.png", size: 9, mtime: 1, dir: false }, { name: "old.pdf", size: 9, mtime: 50, dir: false }],
    [join(set, "WP05 Implementation Environment")]: [{ name: "ACME_IE_V1.1.xlsx", size: 10, mtime: 100, dir: false }],
  };
  const list = (d: string) => tree[d] ?? [];

  test("folders holding WPnn folders become sets, WPs in number order, only office/PDF files", () => {
    const [s] = buildSets([join(set, "WP18 Software User Documentation"), join(set, "WP05 Implementation Environment")], list);
    expect(s.name).toBe("demo / Acme / docs");
    expect([s.label, s.sub]).toEqual(["Acme", "demo"]);
    expect(s.path).toBe("~/artron/demo/Acme/docs");
    expect(s.wps.map(w => [w.wp, w.title])).toEqual([["WP05", "Implementation Environment"], ["WP18", "Software User Documentation"]]);
    expect(s.wps[1].files.map(f => f.name)).toEqual(["ACME_SUD_V1.1.docx", "img/old.pdf"]);   // newest first, lock/dot/png skipped
    expect(s.wps[1].files[0].id).toBe(idOf(join(set, "WP18 Software User Documentation", "ACME_SUD_V1.1.docx")));
  });

  test("short project labels from the folder path", () => {
    const L = (p: string) => Object.values(setLabel(p));
    expect(L("factorypro/Project/acme/Client/docs")).toEqual(["Client", "acme"]);
    expect(L("factorypro/Project/acme2/doc work v.3")).toEqual(["acme2", "doc work v.3"]);
    expect(L("core/sensor-web/docs")).toEqual(["sensor-web", ""]);
    expect(L("core/sensor-web/docs/_archive")).toEqual(["sensor-web", "_archive"]);
    expect(L("factorypro/Project/acme/Client-2/docs")).toEqual(["Client-2", "acme"]);
  });

  test("[TBD] marks: plain, with a note, split across Word runs once tags are stripped", () => {
    expect(countTbd("a [TBD] b [TBD: วันที่] c [ TBD ]")).toBe(3);
    expect(countTbd("<w:t>[</w:t><w:t>TBD]</w:t>".replace(/<[^>]+>/g, ""))).toBe(1);
    expect(countTbd("TBD without brackets")).toBe(0);
  });

  test("PDF text → the lines with [TBD] and their page (pages split by form feed)", () => {
    const pdf = "Title\nno marks\f1  1.0  ฉบับร่างแรก  [TBD]   [TBD]\nกรกมล (PM) ([TBD:\nวันที่])\fdone";
    expect(tbdLines(pdf)).toEqual([{ page: 2, text: "1 1.0 ฉบับร่างแรก [TBD] [TBD]" }, { page: 2, text: "กรกมล (PM) ([TBD:" }]);
  });

  test("page files follow pdftoppm's zero padding", () => {
    expect(pageFile("/c", 3, 9)).toBe("/c/p-3.jpg");
    expect(pageFile("/c", 3, 201)).toBe("/c/p-003.jpg");
  });

  test("unknown ids are refused (only indexed files can be rendered or served)", async () => {
    const routes: Record<string, Function> = {};
    mount({ get: (p: string, h: Function) => { routes["GET " + p] = h; }, post: (p: string, h: Function) => { routes["POST " + p] = h; } });
    const set1: any = {};
    expect(await routes["GET /docs/page"]({ query: { id: idOf("/etc/passwd"), n: "1" }, set: set1 })).toMatchObject({ ok: false });
    expect(set1.status).toBe(404);
  });
});

describe("docs versions", () => {
  const { markOld, versionOf } = require("../src/mobile/features/docs");
  test("older _V files are marked old, per base name and extension", () => {
    const f = (name: string) => ({ id: name, path: name, name, ext: name.split(".").pop(), size: 1, mtime: 1, tbd: 1 });
    const files = [f("ACME_SUD_V1.1.docx"), f("ACME_SUD_V1.0.docx"), f("ACME_SUD_V1.0.pdf"), f("ACME_SD_V1.0.docx"), f("MoM_Kickoff.docx"), f("X_v2.docx"), f("X_v10.docx")];
    markOld(files);
    expect(files.filter((x: any) => x.old).map((x: any) => x.name)).toEqual(["ACME_SUD_V1.0.docx", "X_v2.docx"]);
    expect(versionOf("MoM_Kickoff.docx")).toBeNull();
  });
});

describe("docs pen marks", () => {
  const { familyOf, marksMessage } = require("../src/mobile/features/docs");
  test("marks follow the document across versions", () => {
    expect(familyOf("/d/WP18/ACME_SUD_V1.1.docx")).toBe(familyOf("/d/WP18/ACME_SUD_V1.2.docx"));
    expect(familyOf("/d/WP18/ACME_SUD_V1.1.docx")).not.toBe(familyOf("/d/WP18/ACME_SUD_V1.1.pdf"));
    expect(familyOf("/d/WP07/MoM_Kickoff.docx")).toBe("/d/WP07/mom_kickoff.docx");
  });
  test("the room gets one line: file, count, then page · note · image per mark", () => {
    const msg = marksMessage("/x/ACME_SUD_V1.1.docx", [{ page: 3, note: "เปลี่ยนเป็น\n1.0.3", img: "/m/a.jpg" }, { page: 9, note: "", img: "/m/b.jpg" }]);
    expect(msg).not.toContain("\n");
    expect(msg).toContain("ACME_SUD_V1.1.docx");
    expect(msg).toContain("2 จุด");
    expect(msg).toContain("(1) หน้า 3 — เปลี่ยนเป็น 1.0.3 · ภาพ /m/a.jpg");
    expect(msg).toContain("(2) หน้า 9 · ภาพ /m/b.jpg");
  });
});
