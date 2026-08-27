/* people.jsx — a durable mxid -> email directory, shared across the room.
 *
 * entity_type 'person', one row per mxid, keyed by a DETERMINISTIC anchor
 * (not the usual content-addressed hash) so two different members
 * registering the same person's email land on the same row instead of
 * creating duplicates. This is the one place in the app that departs
 * from "anchor = hash of creation content" — a directory needs a stable
 * primary key, and a mxid already is one.
 *
 * Registered in _schema.tables on first use, so it's also just a normal
 * browsable table (table/graph/timeline views) for free — no bespoke
 * grid needed.
 *
 * Feeds two things: subscribe-button.jsx's per-task "email me changes"
 * (a personal, per-subscription override) and broadcast-view.jsx's bulk
 * sender (which looks recipients up here so nobody has to retype an
 * address they already gave once, e.g. on an invite).
 *
 * Known race: if two clients both discover "no person row yet" for the
 * same mxid at nearly the same moment and both emit INS, the fold's INS
 * case unconditionally resets state.entities[anchor] — a DEF that landed
 * between the two INS events would be wiped when the log replays. Rare
 * (registering an email is an infrequent, low-stakes action) and self-
 * healing (re-setting the email fixes it), so accepted rather than
 * solved with real distributed locking.
 */
(function () {

function personAnchorFor(mxid) {
  return 'person_' + String(mxid || '').replace(/[^a-zA-Z0-9]/g, '_');
}

function findPerson(state, mxid) {
  if (!mxid) return null;
  return state.entities[personAnchorFor(mxid)] || null;
}

function emailFor(state, mxid) {
  return findPerson(state, mxid)?.email || null;
}

/** Every person row that has an email on file. */
function everyoneWithEmail(state) {
  return Object.values(state.entities).filter(e => e._type === 'person' && e.email);
}

async function ensurePersonSchema(onEmit, ME, state) {
  const tables = state.schema?.tables || [];
  if (tables.includes('person')) return;
  await onEmit(ME.OP.DEF, { anchor: null, path: '_schema.tables', value: [...tables, 'person'] });
  await onEmit(ME.OP.DEF, {
    anchor: null, path: '_schema.fields.person',
    value: [{ name: 'mxid', type: 'text' }, { name: 'email', type: 'email' }, { name: 'display_name', type: 'text' }],
  });
}

/** Create-or-update one person's email. Registers the schema on first use. */
async function setPersonEmail(onEmit, ME, state, mxid, email, displayName) {
  if (!mxid || !email) return;
  await ensurePersonSchema(onEmit, ME, state);
  const anchor = personAnchorFor(mxid);
  const existing = state.entities[anchor];
  if (!existing) {
    await onEmit(ME.OP.INS, { anchor, entity_type: 'person', payload: { mxid } });
  }
  await onEmit(ME.OP.DEF, { anchor, path: 'email', value: email });
  if (displayName) await onEmit(ME.OP.DEF, { anchor, path: 'display_name', value: displayName });
}

window.PeopleDirectory = { personAnchorFor, findPerson, emailFor, everyoneWithEmail, ensurePersonSchema, setPersonEmail };

})();
