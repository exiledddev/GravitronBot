'use strict';

/**
 * In-memory fault log behind the bot's status report.
 *
 * Every console.error the bot emits is funnelled in here. Identical faults are
 * folded into one entry with an occurrence count rather than stored again,
 * because the status report has a small, fixed number of slots and one error
 * repeating in a loop would otherwise push every other fault out of view - the
 * exact failure you would most want to still be able to see.
 *
 * Nothing here touches disk. A restart is a clean slate, which is the right
 * behaviour for "what has gone wrong since this process came up".
 */

// Discord select menus allow at most 25 options, so tracking more distinct
// faults than that would create entries the menu could never offer.
const MAX_TRACKED_FAULTS = 25;

// Stack traces are long and the report only ever renders a slice of one, so
// cap what is retained per fault.
const MAX_FAULT_TEXT = 3800;

const faults = new Map();
let nextFaultId = 1;
let totalHits = 0;
let droppedFaults = 0;

/**
 * Collapses the parts of an error that change between otherwise identical
 * occurrences - timestamps, snowflake ids, addresses, stack line numbers - so
 * "Failed to fetch channel 123" and "Failed to fetch channel 456" fold into one
 * fault with a count of 2 instead of two near-duplicate entries.
 */
function normalizeForFingerprint(text) {
  return String(text)
    .replace(/\d{4}-\d{2}-\d{2}T[\d:.]+Z?/g, '<time>')
    .replace(/\b\d{6,}\b/g, '<id>')
    .replace(/0x[0-9a-fA-F]{4,}/g, '<addr>')
    .replace(/:\d+:\d+/g, ':<line>')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 500);
}

/**
 * The first meaningful line of a fault, for menu labels and summary lists.
 * Stack traces start with the message, so this is the useful part.
 */
function getFaultHeadline(fault) {
  const firstLine = String(fault?.message || '')
    .split('\n')
    .map((line) => line.trim())
    .find((line) => line.length > 0);

  return firstLine || 'Unknown fault';
}

function recordFault(text, { at = new Date() } = {}) {
  const message = String(text ?? '').slice(0, MAX_FAULT_TEXT);
  if (!message.trim()) {
    return null;
  }

  const fingerprint = normalizeForFingerprint(message);
  totalHits += 1;

  const existing = faults.get(fingerprint);
  if (existing) {
    existing.count += 1;
    existing.lastSeen = at;
    // Keep the most recent wording, so the ids and numbers shown are current.
    existing.message = message;
    return existing;
  }

  // At capacity, drop the fault that has been quiet longest rather than the
  // one recorded earliest: a burst of new faults should never be hidden behind
  // a single stale entry that has not recurred in hours.
  if (faults.size >= MAX_TRACKED_FAULTS) {
    let oldestKey = null;
    let oldestSeen = Infinity;
    for (const [key, fault] of faults) {
      const seen = fault.lastSeen.getTime();
      if (seen < oldestSeen) {
        oldestSeen = seen;
        oldestKey = key;
      }
    }

    if (oldestKey !== null) {
      faults.delete(oldestKey);
      droppedFaults += 1;
    }
  }

  const fault = {
    id: `f${nextFaultId}`,
    fingerprint,
    message,
    count: 1,
    firstSeen: at,
    lastSeen: at,
  };

  nextFaultId += 1;
  faults.set(fingerprint, fault);

  return fault;
}

/** Faults with the most recent occurrence first. */
function listFaults() {
  return [...faults.values()].sort((a, b) => b.lastSeen.getTime() - a.lastSeen.getTime());
}

function getFault(id) {
  for (const fault of faults.values()) {
    if (fault.id === id) {
      return fault;
    }
  }

  return null;
}

function getDiagnostics() {
  const tracked = listFaults();

  return {
    distinct: tracked.length,
    totalHits,
    dropped: droppedFaults,
    newest: tracked[0] || null,
  };
}

/** Clears the log and reports how many distinct faults were discarded. */
function clearFaults() {
  const cleared = faults.size;
  faults.clear();
  totalHits = 0;
  droppedFaults = 0;

  return cleared;
}

module.exports = {
  MAX_TRACKED_FAULTS,
  recordFault,
  listFaults,
  getFault,
  getFaultHeadline,
  getDiagnostics,
  clearFaults,
};
