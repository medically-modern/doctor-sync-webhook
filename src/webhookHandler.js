const {
  getItemColumns,
  findDoctorsByNPI,
  findDoctorsByName,
  updateDoctorColumn,
  updateDoctorName,
  mondayQuery,
} = require("./mondayApi");

const {
  WATCHED_BOARDS,
  DOCTOR_COLUMN_IDS,
  SOURCE_NPI_COL,
  SOURCE_NAME_COL,
  SOURCE_PHONE_COL,
  mapSourceToDb,
  DB_BOARD_ID,
} = require("./columnMap");

/**
 * Main webhook handler.
 *
 * Monday sends: { event: { boardId, pulseId, columnId, value, previousValue, ... } }
 */
async function handleWebhook(body) {
  const event = body.event;
  if (!event) {
    console.log("[SKIP] No event in payload");
    return;
  }

  const { boardId, pulseId, columnId } = event;
  const boardIdStr = String(boardId);
  const itemId = String(pulseId);

  console.log(`[WEBHOOK] Board=${boardIdStr} Item=${itemId} Column=${columnId}`);

  // 1. Is this a watched board?
  if (!WATCHED_BOARDS.includes(boardIdStr)) {
    console.log(`[SKIP] Board ${boardIdStr} is not in watched list`);
    return;
  }

  // 2. Is this a doctor-info column?
  if (!DOCTOR_COLUMN_IDS.includes(columnId)) {
    console.log(`[SKIP] Column ${columnId} is not a doctor-info column`);
    return;
  }

  console.log(`[PROCESS] Doctor column changed: ${columnId}`);

  // 3. Fetch the full item to get NPI + Doctor Name + the changed column value
  const sourceItem = await getItemColumns(itemId);
  if (!sourceItem) {
    console.error(`[ERROR] Could not fetch item ${itemId} from board ${boardIdStr}`);
    return;
  }

  // Extract NPI from the source item
  const npiCol = sourceItem.column_values.find((cv) => cv.id === SOURCE_NPI_COL);
  const npi = npiCol?.text?.trim();

  // Extract Doctor Name from the source item
  const nameCol = sourceItem.column_values.find((cv) => cv.id === SOURCE_NAME_COL);
  const sourceDoctorName = nameCol?.text?.trim() || "";

  // ── SPECIAL CASE: NPI column changed ──
  // When someone corrects the NPI, we can't look up by NPI (the DB still has the old one).
  // Instead, look up by doctor name + phone number to find the exact match, then update the NPI.
  if (columnId === SOURCE_NPI_COL) {
    if (!npi) {
      console.log(`[SKIP] NPI was cleared — nothing to sync`);
      return;
    }
    if (!sourceDoctorName) {
      console.log(`[SKIP] No doctor name on source item — cannot look up by name`);
      return;
    }

    // Extract phone from the source item for secondary matching
    const phoneCol = sourceItem.column_values.find((cv) => cv.id === SOURCE_PHONE_COL);
    const sourcePhone = extractPhoneDigits(phoneCol?.text);

    if (!sourcePhone) {
      console.log(`[SKIP] No phone number on source item — need name + phone to match for NPI update`);
      return;
    }

    console.log(`[NPI-CHANGE] Looking up doctor by name: "${sourceDoctorName}" phone: ${sourcePhone}`);
    const dbDoctors = await findDoctorsByName(sourceDoctorName);

    if (dbDoctors.length === 0) {
      console.log(`[NOT FOUND] No doctor in DB with name "${sourceDoctorName}" — cannot update NPI`);
      return;
    }

    // Find the one whose phone matches
    const dbDoctor = dbDoctors.find((doc) => {
      const dbPhoneCol = doc.column_values.find((cv) => cv.id === "phone");
      const dbPhone = extractPhoneDigits(dbPhoneCol?.text);
      return dbPhone === sourcePhone;
    });

    if (!dbDoctor) {
      const dbPhones = dbDoctors.map((d) => {
        const p = d.column_values.find((cv) => cv.id === "phone");
        return `"${d.name}" phone=${p?.text || "empty"}`;
      });
      console.log(
        `[NO PHONE MATCH] Found ${dbDoctors.length} doctor(s) named "${sourceDoctorName}" but none matched phone ${sourcePhone}: ${dbPhones.join(", ")}`
      );
      return;
    }

    console.log(`[FOUND] DB Doctor: "${dbDoctor.name}" (id: ${dbDoctor.id}) — name + phone matched`);

    try {
      const npiValue = JSON.stringify(npi);
      console.log(`[UPDATE] Setting NPI to ${npi} for DB doctor "${dbDoctor.name}"`);
      await updateDoctorColumn(dbDoctor.id, "text_mkwhtqjb", npiValue);
      console.log(`[SUCCESS] NPI updated for doctor "${dbDoctor.name}"`);
    } catch (err) {
      console.error(`[ERROR] Failed to update NPI for doctor ${dbDoctor.id}:`, err.message);
    }
    return;
  }

  // ── STANDARD FLOW: non-NPI column changed ──
  if (!npi) {
    console.log(`[SKIP] Item ${itemId} has no NPI value — cannot look up doctor`);
    return;
  }

  console.log(`[LOOKUP] NPI=${npi} DoctorName="${sourceDoctorName}"`);

  // 4. Every Doctor Database entry with this NPI (one per office the doctor works at)
  const byNpi = await findDoctorsByNPI(npi);

  if (byNpi.length === 0) {
    console.log(`[NOT FOUND] No doctor in DB with NPI=${npi} (source name: "${sourceDoctorName}")`);
    return;
  }

  // 5. Safety check: NPI matched, but does the name match? Credentials
  //    ("Allyson Quinn, PA-C" vs "Allyson Quinn") don't count as a difference.
  const named = byNpi.filter((d) => namesMatch(sourceDoctorName, d.name));
  if (named.length === 0) {
    console.warn(
      `[NAME MISMATCH] NPI=${npi} matched DB doctor "${byNpi[0].name?.trim() || ""}" but source has "${sourceDoctorName}" — SKIPPING UPDATE`
    );
    return;
  }

  // 5b. Several entries (offices) under this NPI: write only to the one this
  //     patient is seen at, never the first Monday happens to return.
  const picked = pickLocation(named, sourceItem, columnId);
  if (!picked.entry) {
    console.warn(`[AMBIGUOUS] NPI=${npi} has ${named.length} DB entries for "${sourceDoctorName}" and ${picked.why} — SKIPPING UPDATE`);
    return;
  }
  const dbDoctor = picked.entry;
  console.log(`[FOUND] DB Doctor: "${dbDoctor.name}" (id: ${dbDoctor.id})${named.length > 1 ? ` — ${picked.why}` : ""}`);
  const dbDoctorName = dbDoctor.name?.trim() || "";

  // 6. Map the changed column to the DB column and update
  const mapping = mapSourceToDb(columnId);
  if (!mapping) {
    console.error(`[ERROR] No mapping found for column ${columnId} — this should not happen`);
    return;
  }

  // Get the changed column's current value from the source item
  const changedCol = sourceItem.column_values.find((cv) => cv.id === columnId);

  try {
    if (mapping.isItemName) {
      // Special case: updating the item name (Doctor Name)
      const newName = changedCol?.text?.trim() || "";
      if (!newName) {
        console.log(`[SKIP] New doctor name is empty`);
        return;
      }
      console.log(`[UPDATE] Updating DB doctor name from "${dbDoctorName}" to "${newName}"`);
      await updateDoctorName(dbDoctor.id, newName);
      console.log(`[SUCCESS] Doctor name updated`);
    } else if (mapping.isDropdown) {
      // Dropdown: match by label text
      await handleDropdownUpdate(dbDoctor.id, mapping.dbColumnId, changedCol);
    } else if (mapping.isStatus) {
      // Status: sync by label text — index mappings differ between boards
      const label = changedCol?.text?.trim();
      if (!label) {
        console.log(`[SKIP] Status value is empty for column ${columnId}`);
        return;
      }
      const value = JSON.stringify({ label });
      console.log(`[UPDATE] Setting status ${mapping.dbColumnId} to label "${label}"`);
      await updateDoctorColumn(dbDoctor.id, mapping.dbColumnId, value);
      console.log(`[SUCCESS] Status ${mapping.dbColumnId} set to "${label}" for doctor "${dbDoctorName}"`);
    } else {
      // Standard column update
      const newValue = mapping.transformValue
        ? mapping.transformValue(changedCol?.value)
        : changedCol?.value;

      if (newValue === null || newValue === undefined) {
        console.log(`[SKIP] Transformed value is null for column ${columnId}`);
        return;
      }

      console.log(`[UPDATE] Setting DB column ${mapping.dbColumnId} = ${newValue}`);
      await updateDoctorColumn(dbDoctor.id, mapping.dbColumnId, newValue);
      console.log(`[SUCCESS] Column ${mapping.dbColumnId} updated for doctor "${dbDoctorName}"`);
    }
  } catch (err) {
    console.error(`[ERROR] Failed to update DB doctor ${dbDoctor.id}:`, err.message);
  }
}

/**
 * Handle dropdown column updates by matching label text.
 * Source and DB dropdown boards may have different label IDs for the same text.
 */
async function handleDropdownUpdate(dbItemId, dbColumnId, sourceCol) {
  const sourceText = sourceCol?.text?.trim();
  if (!sourceText) {
    console.log(`[SKIP] Dropdown value is empty`);
    return;
  }

  console.log(`[DROPDOWN] Looking up label "${sourceText}" in DB column ${dbColumnId}`);

  // Get the DB board's dropdown settings to find the matching label ID
  const data = await mondayQuery(
    `query ($boardId: [ID!]!) {
      boards(ids: $boardId) {
        columns {
          id
          settings_str
        }
      }
    }`,
    { boardId: [DB_BOARD_ID] }
  );

  const dbColumn = data.boards[0]?.columns.find((c) => c.id === dbColumnId);
  if (!dbColumn) {
    console.error(`[ERROR] DB column ${dbColumnId} not found`);
    return;
  }

  const settings = JSON.parse(dbColumn.settings_str);
  const labels = settings.labels || [];

  // Find the label that matches the source text
  const matchingLabel = labels.find(
    (l) => l.name.trim().toLowerCase() === sourceText.toLowerCase()
  );

  if (!matchingLabel) {
    // Label doesn't exist in the DB dropdown — create it and set it in one call.
    // Using a JSON {"labels":[...]} value preserves commas inside label names.
    console.log(`[DROPDOWN] Label "${sourceText}" not in DB dropdown — auto-creating`);
    const createValue = JSON.stringify({ labels: [sourceText] });
    await updateDoctorColumn(dbItemId, dbColumnId, createValue, true);
    console.log(`[SUCCESS] Dropdown label "${sourceText}" created and set`);
    return;
  }

  const value = JSON.stringify({ ids: [matchingLabel.id] });
  console.log(`[UPDATE] Setting dropdown ${dbColumnId} to label id=${matchingLabel.id} ("${matchingLabel.name}")`);
  await updateDoctorColumn(dbItemId, dbColumnId, value);
  console.log(`[SUCCESS] Dropdown updated`);
}

/**
 * Extract just the digits from a phone string for comparison.
 * "570-887-3131" → "5708873131", "(570) 887-3131" → "5708873131"
 */
function extractPhoneDigits(phoneStr) {
  if (!phoneStr) return "";
  let digits = phoneStr.replace(/\D/g, "");
  // Normalize US numbers: drop leading country code "1" (11 digits → 10)
  // so "+1 212-263-9910" matches "212-263-9910"
  if (digits.length === 11 && digits.startsWith("1")) {
    digits = digits.slice(1);
  }
  return digits;
}

/**
 * Compare doctor names after normalization: case, spacing, a leading "Dr.",
 * trailing credentials and suffixes (MD, DO, NP, PA-C, FNP-BC, Jr ...), and
 * "Last, First". Credentials stop only while two name tokens remain, so
 * "Anh Do, MD" is "anh do", not "anh". The same rule as
 * josh-monday-automations' prescriber-requirements sync.
 */
function normalizeName(name) {
  let n = String(name || "").toLowerCase().trim().replace(/\./g, "").replace(/\s+/g, " ");
  n = n.replace(/^dr\s+/, "");
  const CREDS = /(?:\s|,)+(?:md|do|np|pa|pa-c|dnp|aprn|fnp|fnp-c|fnp-bc|crnp|cnp|rn|msn|cde|cdces|mbbs|phd|facp|face|jr|sr|ii|iii|iv)\s*$/;
  for (;;) {
    const stripped = n.replace(CREDS, "").trim();
    if (stripped === n || stripped.split(/\s+/).filter(Boolean).length < 2) break;
    n = stripped;
  }
  n = n.replace(/,\s*$/, "");
  if (n.includes(",")) {
    const parts = n.split(",").map((p) => p.trim()).filter(Boolean);
    if (parts.length === 2) n = `${parts[1]} ${parts[0]}`;
  }
  return n.replace(/\s+/g, " ").trim();
}

/**
 * The NPI already matched, so the name only guards against a wrong NPI: the
 * same first and last name is enough. A middle name or initial ("Cara Lynn
 * Cahill", "Katherine A. Beckwith") and a space inside a surname ("De Rosairo")
 * don't make two different people.
 */
function namesMatch(name1, name2) {
  const n1 = normalizeName(name1);
  const n2 = normalizeName(name2);
  if (!n1 || !n2) return false;
  if (n1 === n2 || n1.replace(/\s/g, "") === n2.replace(/\s/g, "")) return true;
  const t1 = n1.split(" "), t2 = n2.split(" ");
  if (t1.length < 2 || t2.length < 2) return false;
  return t1[0] === t2[0] && t1[t1.length - 1] === t2[t2.length - 1];
}

/** "1150 Saint Nicholas Ave Fl 2, New York, NY 10032" -> { street: "1150 saint", zip: "10032" } */
function addressKey(text) {
  const t = String(text || "").toLowerCase();
  const m = t.match(/(\d+[a-z]?)\s+([a-z0-9]+)/);
  if (!m) return null;
  const zip = (t.match(/\b(\d{5})(?:-\d{4})?\s*$/) || [])[1] || "";
  return { street: `${m[1]} ${m[2]}`, zip };
}
function sameAddress(a, b) {
  const x = addressKey(a), y = addressKey(b);
  if (!x || !y || x.street !== y.street) return false;
  return !x.zip || !y.zip || x.zip === y.zip;
}
const digitsOf = (t) => extractPhoneDigits(String(t || "").split("@")[0]);
const sameText = (a, b) => Boolean(a && b) && a.trim().toLowerCase() === b.trim().toLowerCase();

/**
 * Which of a doctor's entries (one per office) this patient's edit belongs to.
 * One entry: that one. Several: narrow by the patient's other doctor fields,
 * in order clinic address, clinic name, fax, phone — skipping the column being
 * edited, whose new value the entry doesn't hold yet. A field that rules out
 * every entry is ignored (the entry may simply be blank there); one that
 * leaves a single entry decides. Still several, or none told apart: no entry,
 * and nothing is written.
 */
function pickLocation(entries, sourceItem, changedColumnId) {
  if (entries.length === 1) return { entry: entries[0], why: "only entry" };
  const src = (id) => sourceItem.column_values.find((cv) => cv.id === id)?.text?.trim() || "";
  const db = (e, id) => e.column_values.find((cv) => cv.id === id)?.text?.trim() || "";
  const keys = [
    { label: "clinic address", source: "location_mm1xjnfv", dbCol: "text_mkzc21ns", same: sameAddress },
    { label: "clinic name", source: "dropdown_mm1xbvas", dbCol: "dropdown_mm1vd9fs", same: sameText },
    { label: "fax", source: "email_mm1xdzcj", dbCol: "email_mkwh2ywd", same: (a, b) => Boolean(digitsOf(a)) && digitsOf(a) === digitsOf(b) },
    { label: "phone", source: "phone_mm1xz8c0", dbCol: "phone", same: (a, b) => Boolean(digitsOf(a)) && digitsOf(a) === digitsOf(b) },
  ];
  let left = entries;
  const used = [];
  for (const k of keys) {
    if (k.source === changedColumnId) continue;
    const value = src(k.source);
    if (!value) continue;
    const hit = left.filter((e) => k.same(value, db(e, k.dbCol)));
    if (hit.length === 0) continue;
    left = hit;
    used.push(k.label);
    if (left.length === 1) return { entry: left[0], why: `matched on ${used.join(" + ")}` };
  }
  return { entry: null, why: used.length ? `${left.length} still match on ${used.join(" + ")}` : "none matches the patient's clinic address, clinic, fax or phone" };
}

module.exports = { handleWebhook, namesMatch, pickLocation };
