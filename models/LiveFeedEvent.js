

const mongoose = require('mongoose');

const { Schema } = mongoose;

/**
 * LiveFeedEvent
 * Small, append-only event stream backing the Live Feed UI.
 * Each event mirrors a socket emission so we can page history reliably.
 *
 * TTL retention is controlled by env LIVE_FEED_TTL_DAYS (default 30).
 * Set to 0 or a negative number to disable TTL expiry.
 */
const LiveFeedEventSchema = new Schema(
  {
    ts: { type: Date, required: true, default: Date.now }, // event timestamp
    type: {
      type: String,
      required: true,
      enum: ['roomUpdate', 'roomChecked', 'dndUpdate', 'priorityUpdate', 'noteUpdate', 'system'],
    },
    roomNumber: { type: String, default: null }, // always 3-digit padded on write helper
    payload: { type: Schema.Types.Mixed, default: {} }, // raw payload emitted to clients
    meta: { type: Schema.Types.Mixed, default: {} }, // optional: actor, propertyId, etc.
  },
  { timestamps: false, versionKey: false }
);

// Sorting & query helpers
LiveFeedEventSchema.index({ ts: -1 });
LiveFeedEventSchema.index({ type: 1, roomNumber: 1, ts: -1 });

// TTL index (Atlas TTLMonitor must be enabled; it is by default)
const ttlDays = parseInt(process.env.LIVE_FEED_TTL_DAYS || '30', 10);
if (!Number.isNaN(ttlDays) && ttlDays > 0) {
  LiveFeedEventSchema.index({ ts: 1 }, { expireAfterSeconds: ttlDays * 24 * 60 * 60 });
}

module.exports = mongoose.models.LiveFeedEvent || mongoose.model('LiveFeedEvent', LiveFeedEventSchema);