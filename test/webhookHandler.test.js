// What a doctor-info edit on a pipeline board copies into the Doctor Database.
// Runs the real handleWebhook (src/webhookHandler.js) and the real column map
// (src/columnMap.js); only src/mondayApi.js is replaced, by an in-memory
// pipeline item and directory, so nothing here talks to Monday.
const { test, beforeEach } = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");

// ─── The stand-in for src/mondayApi.js ───
const sourceItems = new Map();
let directory = [];
const writes = [];
let dbDropdownLabels = [];

const mondayApi = {
  async getItemColumns(itemId) { return sourceItems.get(String(itemId)) || null; },
  async findDoctorByNPI(npi) {
    return directory.find((d) => d.column_values.some((c) => c.id === "text_mkwhtqjb" && c.text === String(npi))) || null;
  },
  async findDoctorsByName(name) { return directory.filter((d) => d.name === String(name)); },
  async updateDoctorColumn(itemId, columnId, value, createLabelsIfMissing = false) {
    writes.push({ itemId: String(itemId), columnId, value, createLabelsIfMissing });
  },
  async updateDoctorName(itemId, name) { writes.push({ itemId: String(itemId), columnId: "name", value: name }); },
  async mondayQuery() {
    return { boards: [{ columns: [{ id: "dropdown_mm1vd9fs", settings_str: JSON.stringify({ labels: dbDropdownLabels }) }] }] };
  }
};
const apiPath = require.resolve(path.join(__dirname, "..", "src", "mondayApi.js"));
require.cache[apiPath] = { id: apiPath, filename: apiPath, loaded: true, exports: mondayApi, children: [], paths: [] };

const { handleWebhook } = require("../src/webhookHandler");

// ─── Fixtures: made up ───
const MED_EVAL = 18406060017;
const COL = {
  name: "text_mm1x46et", phone: "phone_mm1xz8c0", npi: "text_mm1x7d91", method: "color_mm1xw7y5",
  email: "email_mm1x6fq5", fax: "email_mm1xdzcj", clinic: "dropdown_mm1xbvas", address: "location_mm1xjnfv"
};
const SOURCE_ID = "7000000001";

function sourceItem(cols) {
  sourceItems.set(SOURCE_ID, {
    id: SOURCE_ID, name: "TEST Patient",
    column_values: Object.entries(cols).map(([id, v]) => ({ id, text: v.text ?? "", value: v.value ?? null }))
  });
}
function directoryEntry(id, name, { npi = "", phone = "" } = {}) {
  return {
    id, name,
    column_values: [{ id: "text_mkwhtqjb", text: npi, value: npi ? JSON.stringify(npi) : null }, { id: "phone", text: phone, value: null }]
  };
}
const edit = (columnId, boardId = MED_EVAL) => handleWebhook({ event: { boardId, pulseId: Number(SOURCE_ID), columnId } });

beforeEach(() => {
  sourceItems.clear();
  directory = [];
  writes.length = 0;
  dbDropdownLabels = [];
});

test("a Doctor Phone edit is copied to the directory entry whose NPI and name both match", async () => {
  directory = [directoryEntry("501", "Alex Placeholder", { npi: "1000000001" })];
  sourceItem({
    [COL.npi]: { text: "1000000001" }, [COL.name]: { text: "Alex Placeholder" },
    [COL.phone]: { text: "(212) 555-0101", value: JSON.stringify({ phone: "2125550101", countryShortName: "US" }) }
  });
  await edit(COL.phone);
  assert.deepEqual(writes, [{ itemId: "501", columnId: "phone", value: JSON.stringify({ phone: "2125550101", countryShortName: "US" }), createLabelsIfMissing: false }]);
});

test("an edit is still copied when the patient's doctor name differs from the entry only in case, extra spaces or a leading Dr.", async () => {
  directory = [directoryEntry("502", "Alex Placeholder", { npi: "1000000002" })];
  sourceItem({
    [COL.npi]: { text: "1000000002" }, [COL.name]: { text: "dr.  ALEX   placeholder" },
    [COL.email]: { text: "office@example.test", value: JSON.stringify({ email: "office@example.test", text: "office@example.test" }) }
  });
  await edit(COL.email);
  assert.equal(writes.length, 1);
  assert.equal(writes[0].itemId, "502");
  assert.equal(writes[0].columnId, "email");
});

test("an edit whose NPI matches an entry under a different name is not copied", async () => {
  directory = [directoryEntry("503", "Alex Placeholder", { npi: "1000000003" })];
  sourceItem({
    [COL.npi]: { text: "1000000003" }, [COL.name]: { text: "Jordan Example" },
    [COL.fax]: { text: "2125550102@rcfax.com", value: JSON.stringify({ email: "2125550102@rcfax.com", text: "2125550102@rcfax.com" }) }
  });
  await edit(COL.fax);
  assert.equal(writes.length, 0);
});

test("an edit on a patient whose NPI is not in the directory, or who has no NPI, is not copied", async () => {
  directory = [directoryEntry("504", "Alex Placeholder", { npi: "1000000004" })];
  sourceItem({ [COL.npi]: { text: "1999999999" }, [COL.name]: { text: "Alex Placeholder" }, [COL.method]: { text: "Fax" } });
  await edit(COL.method);
  sourceItem({ [COL.npi]: { text: "" }, [COL.name]: { text: "Alex Placeholder" }, [COL.method]: { text: "Fax" } });
  await edit(COL.method);
  assert.equal(writes.length, 0);
});

test("a corrected Doctor Name is not copied: the edited name no longer matches the entry the NPI finds", async () => {
  directory = [directoryEntry("505", "Alex Placeholder", { npi: "1000000005" })];
  sourceItem({ [COL.npi]: { text: "1000000005" }, [COL.name]: { text: "Alexandra Placeholder" } });
  await edit(COL.name);
  assert.equal(writes.length, 0);
});

test("a Clinicals Method edit is copied by its label text, not its index", async () => {
  directory = [directoryEntry("506", "Alex Placeholder", { npi: "1000000006" })];
  sourceItem({ [COL.npi]: { text: "1000000006" }, [COL.name]: { text: "Alex Placeholder" }, [COL.method]: { text: "Parachute", value: JSON.stringify({ index: 1 }) } });
  await edit(COL.method);
  assert.deepEqual(writes, [{ itemId: "506", columnId: "color_mm1vr8rd", value: JSON.stringify({ label: "Parachute" }), createLabelsIfMissing: false }]);
});

test("a Clinic Name edit picks the directory's own label with that name, or creates the label when the directory has none", async () => {
  directory = [directoryEntry("507", "Alex Placeholder", { npi: "1000000007" })];
  sourceItem({ [COL.npi]: { text: "1000000007" }, [COL.name]: { text: "Alex Placeholder" }, [COL.clinic]: { text: "Sample Endocrine Group" } });
  dbDropdownLabels = [{ id: 12, name: "sample endocrine group" }];
  await edit(COL.clinic);
  dbDropdownLabels = [{ id: 12, name: "Another Practice" }];
  await edit(COL.clinic);
  assert.deepEqual(writes, [
    { itemId: "507", columnId: "dropdown_mm1vd9fs", value: JSON.stringify({ ids: [12] }), createLabelsIfMissing: false },
    { itemId: "507", columnId: "dropdown_mm1vd9fs", value: JSON.stringify({ labels: ["Sample Endocrine Group"] }), createLabelsIfMissing: true }
  ]);
});

test("a changed NPI is written to the same-named entry whose phone matches, ignoring formatting and a leading US 1", async () => {
  directory = [
    directoryEntry("508", "Alex Placeholder", { npi: "1000000008", phone: "(212) 555-0103" }),
    directoryEntry("509", "Alex Placeholder", { npi: "1000000009", phone: "212-555-0104" })
  ];
  sourceItem({ [COL.npi]: { text: "1000000010" }, [COL.name]: { text: "Alex Placeholder" }, [COL.phone]: { text: "+1 212 555 0104" } });
  await edit(COL.npi);
  assert.deepEqual(writes, [{ itemId: "509", columnId: "text_mkwhtqjb", value: JSON.stringify("1000000010"), createLabelsIfMissing: false }]);
});

test("a changed NPI is not written when no same-named entry has the patient's doctor phone, or the patient has no doctor phone", async () => {
  directory = [directoryEntry("510", "Alex Placeholder", { npi: "1000000011", phone: "(212) 555-0105" })];
  sourceItem({ [COL.npi]: { text: "1000000012" }, [COL.name]: { text: "Alex Placeholder" }, [COL.phone]: { text: "(212) 555-0106" } });
  await edit(COL.npi);
  sourceItem({ [COL.npi]: { text: "1000000012" }, [COL.name]: { text: "Alex Placeholder" }, [COL.phone]: { text: "" } });
  await edit(COL.npi);
  assert.equal(writes.length, 0);
});

test("an edit on a board that is not watched, or to a column that is not doctor info, is not copied", async () => {
  directory = [directoryEntry("511", "Alex Placeholder", { npi: "1000000013" })];
  sourceItem({
    [COL.npi]: { text: "1000000013" }, [COL.name]: { text: "Alex Placeholder" },
    [COL.phone]: { text: "(212) 555-0107", value: JSON.stringify({ phone: "2125550107", countryShortName: "US" }) },
    text_unrelated: { text: "x" }
  });
  await edit(COL.phone, 18407459988); // Subscription: not watched
  await edit("text_unrelated");
  assert.equal(writes.length, 0);
});

test("Profile Send Off, Medical Evaluation, Insurance and Welcome Call edits are all copied", async () => {
  directory = [directoryEntry("512", "Alex Placeholder", { npi: "1000000014" })];
  sourceItem({ [COL.npi]: { text: "1000000014" }, [COL.name]: { text: "Alex Placeholder" }, [COL.method]: { text: "Email" } });
  for (const board of [18406352652, 18406060017, 18410601299, 18410804557]) await edit(COL.method, board);
  assert.equal(writes.length, 4);
});
