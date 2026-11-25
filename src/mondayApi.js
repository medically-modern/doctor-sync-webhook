// Monday's API address. A setting so the January cutover can point it at Friday (/v2); unset, it is Monday.
const MONDAY_API_URL = process.env.MONDAY_API_URL || "https://api.monday.com/v2";
const MONDAY_TOKEN = process.env.MONDAY_API_TOKEN;
const { createFridayForward } = require("./fridayForward");

// The Friday forward (fridayForward.js): every mutation Monday accepts through mondayQuery below is
// handed to Friday afterwards, exactly as sent, so Friday's copy of the Doctor Database gets the same
// writes. It runs after Monday's answer, on a timer, and can never fail or delay a Monday call. Off
// unless FRIDAY_FORWARD=1 (with FRIDAY_URL and FRIDAY_API_KEY); FRIDAY_BOARD_IDS names the boards.
const fridayForward = createFridayForward({ env: process.env, log: console.log, service: "doctor-sync-webhook" });

// The Friday read shadow (fridayShadow.js): every read Monday answers through mondayQuery is handed, with
// Monday's answer, to Friday's /v2/shadow, which runs the same read on Friday and keeps how the two compare
// (counts and paths, never a value). After the answer, never awaited, never throws, never a mutation. Off
// unless FRIDAY_SHADOW=1 (with FRIDAY_URL and FRIDAY_API_KEY, or FRIDAY_SHADOW_URL / FRIDAY_SHADOW_KEY).
const { createFridayShadow } = require("./fridayShadow");
const fridayShadow = createFridayShadow({ env: process.env, log: console.log, reader: "doctor-sync-webhook" });

if (!MONDAY_TOKEN) {
  console.warn("[WARN] MONDAY_API_TOKEN not set — API calls will fail");
}

/**
 * Execute a Monday.com GraphQL query
 */
async function mondayQuery(query, variables = {}) {
  const started = Date.now();
  const res = await fetch(MONDAY_API_URL, {
    method: "POST",
    headers: {
      Authorization: MONDAY_TOKEN,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ query, variables }),
  });

  const data = await res.json();

  if (data.errors) {
    const msg = data.errors.map((e) => e.message).join("; ");
    throw new Error(`Monday API error: ${msg}`);
  }

  if (res.ok && data.data) fridayForward.onMutation({ query, variables, data: data.data });   // Monday said yes: Friday hears the same write
  // A read Monday answered: Friday runs it too (never awaited, never a mutation).
  if (res.ok && data.data && typeof data.data === "object" && !/^\s*mutation\b/i.test(String(query))) {
    fridayShadow.onRead({ query, variables, status: res.status, json: data, ms: Date.now() - started });
  }
  return data.data;
}

/**
 * Fetch a single item's column values from any board
 */
async function getItemColumns(itemId, columnIds) {
  const data = await mondayQuery(
    `query ($itemId: [ID!]!) {
      items(ids: $itemId) {
        id
        name
        column_values {
          id
          type
          text
          value
        }
      }
    }`,
    { itemId: [String(itemId)] }
  );

  if (!data.items || data.items.length === 0) return null;
  return data.items[0];
}

/**
 * Search the Doctor Database board for a doctor by NPI
 * Returns the first matching item or null
 */
async function findDoctorByNPI(npi) {
  const DB_BOARD_ID = "18142847597";
  const NPI_COLUMN_ID = "text_mkwhtqjb";

  // Use items_page_by_column_values for exact match
  const data = await mondayQuery(
    `query ($boardId: ID!, $columns: [ItemsPageByColumnValuesQuery!]!) {
      items_page_by_column_values(board_id: $boardId, limit: 5, columns: $columns) {
        items {
          id
          name
          column_values {
            id
            type
            text
            value
          }
        }
      }
    }`,
    {
      boardId: DB_BOARD_ID,
      columns: [{ column_id: NPI_COLUMN_ID, column_values: [String(npi)] }],
    }
  );

  const items = data.items_page_by_column_values?.items || [];
  return items.length > 0 ? items[0] : null;
}

/**
 * Every Doctor Database entry with this NPI. A doctor seen at several offices
 * has one entry per office under the same NPI, so the caller picks the right
 * one (webhookHandler.pickLocation) instead of taking whichever comes first.
 */
async function findDoctorsByNPI(npi) {
  const data = await mondayQuery(
    `query ($boardId: ID!, $columns: [ItemsPageByColumnValuesQuery!]!) {
      items_page_by_column_values(board_id: $boardId, limit: 50, columns: $columns) {
        items { id name column_values { id type text value } }
      }
    }`,
    { boardId: "18142847597", columns: [{ column_id: "text_mkwhtqjb", column_values: [String(npi)] }] }
  );
  return data.items_page_by_column_values?.items || [];
}


/**
 * Search the Doctor Database board for doctors by name (exact match).
 * Used when the NPI column itself is changed — we can't look up by NPI
 * because the DB may still have the old/wrong one.
 * Returns ALL matching items (array), since multiple doctors can share a name.
 */
async function findDoctorsByName(name) {
  const DB_BOARD_ID = "18142847597";

  // Use items_page_by_column_values on the "name" column
  const data = await mondayQuery(
    `query ($boardId: ID!, $columns: [ItemsPageByColumnValuesQuery!]!) {
      items_page_by_column_values(board_id: $boardId, limit: 20, columns: $columns) {
        items {
          id
          name
          column_values {
            id
            type
            text
            value
          }
        }
      }
    }`,
    {
      boardId: DB_BOARD_ID,
      columns: [{ column_id: "name", column_values: [String(name)] }],
    }
  );

  return data.items_page_by_column_values?.items || [];
}

/**
 * Update a single column value on an item in the Doctor Database
 */
async function updateDoctorColumn(itemId, columnId, value, createLabelsIfMissing = false) {
  const DB_BOARD_ID = "18142847597";

  const data = await mondayQuery(
    `mutation ($boardId: ID!, $itemId: ID!, $columnId: String!, $value: JSON!, $createLabels: Boolean) {
      change_column_value(board_id: $boardId, item_id: $itemId, column_id: $columnId, value: $value, create_labels_if_missing: $createLabels) {
        id
      }
    }`,
    {
      boardId: DB_BOARD_ID,
      itemId: String(itemId),
      columnId,
      value,
      createLabels: createLabelsIfMissing,
    }
  );

  return data;
}

/**
 * Update the item name (Doctor Name) on the Doctor Database
 */
async function updateDoctorName(itemId, newName) {
  const DB_BOARD_ID = "18142847597";

  const data = await mondayQuery(
    `mutation ($boardId: ID!, $itemId: ID!, $columnId: String!, $value: String!) {
      change_simple_column_value(board_id: $boardId, item_id: $itemId, column_id: $columnId, value: $value) {
        id
      }
    }`,
    {
      boardId: DB_BOARD_ID,
      itemId: String(itemId),
      columnId: "name",
      value: newName,
    }
  );

  return data;
}

module.exports = {
  fridayForward,
  fridayShadow,
  mondayQuery,
  getItemColumns,
  findDoctorByNPI,
  findDoctorsByNPI,
  findDoctorsByName,
  updateDoctorColumn,
  updateDoctorName,
};
