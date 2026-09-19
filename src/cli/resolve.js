'use strict';
// @ts-check
/** Resolve a NAME argument to one registry record, with helpful errors (spec §3.14 "Names"). */
const { matchName, recordName } = require('../common/registry.js');

/**
 * @param {{registry: any, query: string, err: {write: (s: string) => any}}} a
 * @returns {Promise<any|null>}
 */
async function resolveTarget({ registry, query, err }) {
  const records = await registry.list();
  const { record, candidates } = matchName(records, query);
  if (record) return record;
  if (candidates.length > 1) {
    err.write(`ccs: '${query}' matches several sessions: ${candidates.map((r) => recordName(r)).join(', ')}\n`);
  } else {
    err.write(`ccs: no session matches '${query}'${records.length ? ` (have: ${records.map((r) => recordName(r)).join(', ')})` : ' · ccs new creates one'}\n`);
  }
  return null;
}

module.exports = { resolveTarget };
