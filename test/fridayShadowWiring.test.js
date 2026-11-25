// The Friday read shadow is wired, not just written, and the Monday path is unchanged by it: a read returns
// exactly what Monday answered and reaches Friday's /v2/shadow only after that answer; a mutation, a read
// Monday refused or answered with an error status never does; and nothing waits for Friday. Runs the real
// src/mondayApi.js with global fetch stubbed before it loads.
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const { join } = require("node:path");

const SRC = join(__dirname, "..", "src");
const DOCTOR_DB = "18142847597";
const settle = async () => { for (let i = 0; i < 5; i++) await new Promise((r) => setImmediate(r)); };

test("mondayApi.js hands mondayQuery's reads to the shadow after the error check, beside the forward, never awaited", () => {
  const src = readFileSync(join(SRC, "mondayApi.js"), "utf8");
  assert.match(src, /const fridayShadow = createFridayShadow\(\{ env: process\.env, log: console\.log, reader: "doctor-sync-webhook" \}\)/);
  const q = src.slice(src.indexOf("async function mondayQuery("), src.indexOf("async function getItemColumns("));
  const hook = q.indexOf("fridayShadow.onRead({ query, variables, status: res.status, json: data, ms: Date.now() - started })");
  assert.ok(hook > q.lastIndexOf("throw new Error(") && hook > q.indexOf("fridayForward.onMutation(") && hook < q.indexOf("return data.data;"));
  assert.doesNotMatch(src, /await\s+fridayShadow/);
  assert.equal((src.match(/\bfetch\(/g) || []).length, 1, "mondayQuery is still the only Monday call");
  assert.match(readFileSync(join(SRC, "index.js"), "utf8"), /friday_shadow: fridayShadow\.health\(\)/);
});

test("a read reaches Friday after Monday's answer is back; a mutation, a refused read or an error status never does; a hung Friday holds nothing up", async () => {
  for (const k of ["FRIDAY_FORWARD", "FRIDAY_BOARD_IDS", "MONDAY_API_URL"]) delete process.env[k];
  Object.assign(process.env, { MONDAY_API_TOKEN: "test-token", FRIDAY_SHADOW: "1", FRIDAY_URL: "https://friday.invalid", FRIDAY_API_KEY: "fk_live_test" });
  const doctor = { id: "13000000001", name: "x", column_values: [] };
  let monday = { status: 200, body: { data: { items: [doctor] } } };
  const fridayCalls = [];
  let fridayAnswer = async () => ({ ok: true, json: async () => ({ outcome: "same" }) });
  const real = global.fetch;
  global.fetch = async (url, init) => {
    if (String(url).startsWith("https://api.monday.com/")) return { ok: monday.status < 400, status: monday.status, json: async () => monday.body };
    fridayCalls.push({ url: String(url), init });
    return fridayAnswer();
  };
  try {
    for (const f of ["mondayApi.js", "fridayForward.js", "fridayShadow.js"]) delete require.cache[require.resolve(join(SRC, f))];
    const api = require(join(SRC, "mondayApi.js"));
    api.fridayForward.stop();
    assert.deepEqual(await api.getItemColumns(doctor.id), doctor, "Monday's answer, unchanged");
    assert.equal(fridayCalls.length, 0, "the caller has its answer before anything goes to Friday");
    await settle();
    assert.equal(fridayCalls.length, 1);
    assert.equal(fridayCalls[0].url, "https://friday.invalid/v2/shadow");
    const body = JSON.parse(fridayCalls[0].init.body);
    assert.deepEqual(body.variables, { itemId: [doctor.id] });
    assert.equal(body.reader, "doctor-sync-webhook");
    assert.deepEqual(body.monday.body, monday.body);
    assert.equal(api.fridayShadow.health().stats.same, 1);

    monday = { status: 200, body: { data: { change_column_value: { id: "1" } } } };
    await api.mondayQuery(`mutation { change_column_value(board_id: ${DOCTOR_DB}, item_id: 1, column_id: "x", value: "{}") { id } }`);
    monday = { status: 200, body: { errors: [{ message: "nope" }] } };
    await assert.rejects(api.getItemColumns(doctor.id), /Monday API error: nope/);
    monday = { status: 500, body: { data: { items: [] } } };
    await api.mondayQuery("query { items(ids: [1]) { id } }");
    await settle();
    assert.equal(fridayCalls.length, 1, "none of those is shadowed");

    let release;
    fridayAnswer = () => new Promise((r) => { release = r; });
    monday = { status: 200, body: { data: { items: [doctor] } } };
    assert.deepEqual(await api.getItemColumns(doctor.id), doctor);
    await settle();
    assert.equal(fridayCalls.length, 2, "handed over, and the read did not wait for Friday");
    release({ ok: true, json: async () => ({ outcome: "differs" }) });
    await api.fridayShadow.flush(1000);
  } finally {
    global.fetch = real;
    for (const k of ["FRIDAY_SHADOW", "FRIDAY_URL", "FRIDAY_API_KEY"]) delete process.env[k];
  }
});
