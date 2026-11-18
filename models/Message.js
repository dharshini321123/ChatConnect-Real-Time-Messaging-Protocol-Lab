const mongoose = require('mongoose');
const MessageSchema = new mongoose.Schema({
  sender: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  receiver: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  text: { type: String, required: true, trim: true, maxlength: 2000 },
  status: { type: String, enum: ['pending', 'sent', 'read'], default: 'pending' },
  statusHistory: [{ status: { type: String, enum: ['pending', 'sent', 'read'] }, at: { type: Date, default: Date.now } }]
}, { timestamps: true });
MessageSchema.index({ sender: 1, receiver: 1, createdAt: -1 });
module.exports = mongoose.model('Message', MessageSchema);
