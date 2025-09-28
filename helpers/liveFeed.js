

const LiveFeedEvent = require('../models/LiveFeedEvent');

// Pad room numbers like "7" -> "007" for consistent keys in UI & queries
function padRoom(roomNumber) {
  if (roomNumber === undefined || roomNumber === null) return null;
  const n = typeof roomNumber === 'number' ? roomNumber : parseInt(String(roomNumber), 10);
  if (Number.isNaN(n)) return String(roomNumber);
  return String(n).padStart(3, '0');
}

/**
 * Persist an event (unless disabled) and broadcast it over Socket.IO.
 * @param {import('socket.io').Server} io
 * @param {string} type - one of: roomUpdate | roomChecked | dndUpdate | priorityUpdate | noteUpdate | system
 * @param {object} payload - raw payload sent to clients (we keep this shape in DB too)
 * @param {object} [opts]
 * @param {Date|number|string} [opts.ts] - custom timestamp (Date or parsable value). Defaults to now.
 * @param {object} [opts.meta] - optional metadata to store (actor, propertyId, etc.)
 */
async function broadcastAndStore(io, type, payload = {}, opts = {}) {
  const ts = opts.ts ? new Date(opts.ts) : new Date();
  const doc = {
    ts,
    type,
    roomNumber: padRoom(payload.roomNumber),
    payload,
    meta: opts.meta || {},
  };

  // Toggle persistence via env; set LIVE_FEED_PERSIST=false to disable writes
  const persist = (process.env.LIVE_FEED_PERSIST || 'true').toLowerCase() !== 'false';
  if (persist) {
    try {
      await LiveFeedEvent.create(doc);
    } catch (err) {
      console.error('[livefeed] persist error:', err?.message || err);
    }
  }

  // Always broadcast
  try {
    io.emit(type, payload);
  } catch (err) {
    console.error('[livefeed] socket emit error:', err?.message || err);
  }
}

// Convenience wrappers that also normalize roomNumber before emit
function emitRoomUpdate(io, payload, meta) {
  const normalized = { ...payload, roomNumber: padRoom(payload.roomNumber) };
  return broadcastAndStore(io, 'roomUpdate', normalized, { meta });
}
function emitRoomChecked(io, payload, meta) {
  const normalized = { ...payload, roomNumber: padRoom(payload.roomNumber) };
  return broadcastAndStore(io, 'roomChecked', normalized, { meta });
}
function emitDndUpdate(io, payload, meta) {
  const normalized = { ...payload, roomNumber: padRoom(payload.roomNumber) };
  return broadcastAndStore(io, 'dndUpdate', normalized, { meta });
}
function emitPriorityUpdate(io, payload, meta) {
  const normalized = { ...payload, roomNumber: padRoom(payload.roomNumber) };
  return broadcastAndStore(io, 'priorityUpdate', normalized, { meta });
}
function emitNoteUpdate(io, payload, meta) {
  const normalized = { ...payload, roomNumber: padRoom(payload.roomNumber) };
  return broadcastAndStore(io, 'noteUpdate', normalized, { meta });
}

module.exports = {
  broadcastAndStore,
  emitRoomUpdate,
  emitRoomChecked,
  emitDndUpdate,
  emitPriorityUpdate,
  emitNoteUpdate,
  padRoom,
};