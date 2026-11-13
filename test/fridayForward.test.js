// The Friday forward is wired, not just written, and the Monday path is unchanged by it: a write returns
// exactly what Monday answered, whether the forward is off, on, or failing. Runs the real src/mondayApi.js
// with global fetch stubbed before it loads: Monday's address answers from a list, anything else (Friday) is unreachable.
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const { join } = require("node:path");

const SRC = join(__dirname, "..", "src");
const DOCTOR_DB = "18142847597";

function fresh(env) {
  for (const k of ["FRIDAY_FORWARD", "FRIDAY_URL", "FRIDAY_API_KEY", "FRIDAY_BOARD_IDS"]) delete process.env[k];
  Object.assign(process.env, { MONDAY_API_TOKEN: "test-token" }, env);
  for (const f of ["mondayApi.js", "fridayForward.js"]) delete require.cache[require.resolve(join(SRC, f))];
  const api = require(join(SRC, "mondayApi.js"));
  api.fridayForward.stop();
  return api;
}

function stubFetch(mondayAnswers) {
  const calls = { monday: [], friday: [] };
  const real = global.fetch;
  global.fetch = async (url, init) => {
    if (String(url).startsWith("https://api.monday.com/")) {
      calls.monday.push(JSON.parse(init.body));
      const a = mondayAnswers.shift();
      return { ok: a.status ? a.status < 400 : true, status: a.status || 200, json: async () => a.body };
    }
    calls.friday.push(String(url));
    throw new Error("ECONNREFUSED");
  };
  return { calls, restore: () => { global.fetch = real; } };
}

test("mondayApi.js hooks mondayQuery after the error check and before the return; it is the only Monday call", () => {
  const src = readFileSync(join(SRC, "mondayApi.js"), "utf8");
  assert.match(src, /const fridayForward = createFridayForward\(\{ env: process\.env, log: console\.log, service: "doctor-sync-webhook" \}\)/);
  const q = src.slice(src.indexOf("async function mondayQuery("), src.indexOf("async function getItemColumns("));
  const hook = q.indexOf("fridayForward.onMutation({ query, variables, data: data.data })");
  assert.ok(hook > q.lastIndexOf("throw new Error(") && hook < q.indexOf("return data.data;"), "after Monday's errors are checked, before the answer is returned");
  for (const f of ["mondayApi.js", "webhookHandler.js", "columnMap.js", "index.js"]) {
    const s = readFileSync(join(SRC, f), "utf8");
    assert.equal((s.match(/\bfetch\(/g) || []).length, f === "mondayApi.js" ? 1 : 0, `${f}: mondayQuery is the only Monday call`);
  }
  assert.match(readFileSync(join(SRC, "index.js"), "utf8"), /friday: fridayForward\.status\(\)/);
});

test("on: a write Monday accepted is queued for Friday, and Monday's answer comes back unchanged with Friday down", async () => {
  const { calls, restore } = stubFetch([
    { body: { data: { change_column_value: { id: "9001" } } } },
    { body: { data: { change_simple_column_value: { id: "9001" } } } },
    { body: { data: { items_page_by_column_values: { items: [] } } } },
    { body: { errors: [{ message: "bad value" }] } },
    { status: 500, body: { error_message: "Internal server error" } },
  ]);
  const api = fresh({ FRIDAY_FORWARD: "1", FRIDAY_URL: "https://friday.invalid", FRIDAY_API_KEY: "fk_live_test", FRIDAY_BOARD_IDS: DOCTOR_DB });
  try {
    assert.deepEqual(await api.updateDoctorColumn(9001, "text_mkwhtqjb", "1234567890"), { change_column_value: { id: "9001" } }, "Monday's answer, unchanged");
    assert.deepEqual(await api.updateDoctorName(9001, "Made Up"), { change_simple_column_value: { id: "9001" } });
    assert.equal(await api.findDoctorByNPI("1234567890"), null, "a read is answered as before");
    assert.equal(calls.monday.length, 3, "one Monday call each");
    assert.equal(api.fridayForward.queue.length, 2, "the two writes are queued, the read is not");
    assert.equal(api.fridayForward.queue[0].variables.boardId, DOCTOR_DB);
    assert.equal(api.fridayForward.queue[1].query.includes("change_simple_column_value"), true);
    assert.equal((await api.fridayForward.tick()).retry, true, "Friday down is a retry, in the background");
    assert.equal(calls.friday[0], "https://friday.invalid/v1/monday/write");
    await assert.rejects(api.updateDoctorColumn(9001, "text_mkwhtqjb", "x"), /bad value/, "a Monday error still throws as before");
    await api.updateDoctorColumn(9001, "text_mkwhtqjb", "x");
    assert.equal(api.fridayForward.queue.length, 2, "a refused or failed write is never forwarded");
  } finally { restore(); }
});

test("a write on a board FRIDAY_BOARD_IDS doesn't name is not forwarded", async () => {
  const { restore } = stubFetch([{ body: { data: { change_column_value: { id: "9001" } } } }]);
  const api = fresh({ FRIDAY_FORWARD: "1", FRIDAY_URL: "https://friday.invalid", FRIDAY_API_KEY: "fk_live_test", FRIDAY_BOARD_IDS: "18406352652" });
  try {
    await api.updateDoctorColumn(9001, "text_mkwhtqjb", "1234567890");
    assert.equal(api.fridayForward.queue.length, 0);
  } finally { restore(); }
});

test("off by default: nothing is queued and Monday's answer is the same", async () => {
  const { calls, restore } = stubFetch([{ body: { data: { change_column_value: { id: "9001" } } } }]);
  const api = fresh({});
  try {
    assert.deepEqual(await api.updateDoctorColumn(9001, "text_mkwhtqjb", "1234567890"), { change_column_value: { id: "9001" } });
    assert.equal(api.fridayForward.enabled, false);
    assert.equal(api.fridayForward.queue.length, 0);
    assert.equal(calls.friday.length, 0);
    assert.equal(api.fridayForward.status().reason, "FRIDAY_FORWARD is not 1");
  } finally { restore(); }
});
