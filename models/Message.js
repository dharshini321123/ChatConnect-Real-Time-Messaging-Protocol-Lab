
const mongoose = require('mongoose');

// Attachment details
const AttachmentSchema = new mongoose.Schema(
  {
    url: {
      type: String,
      default: ''
    },
    originalName: {
      type: String,
      default: ''
    },
    mimeType: {
      type: String,
      default: ''
    },
    size: {
      type: Number,
      default: 0
    },
    type: {
      type: String,
      enum: ['image', 'file'],
      default: 'file'
    }
  },
  { _id: false }
);

// Message Schema
const MessageSchema = new mongoose.Schema(
  {
    sender: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true
    },

    receiver: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true
    },

    text: {
      type: String,
      default: '',
      trim: true,
      maxlength: 2000
    },

    // Image or file attachment
    attachment: {
      type: AttachmentSchema,
      default: null
    },

    // Reply to another message
    replyTo: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Message',
      default: null
    },

    // Message status
    status: {
      type: String,
      enum: ['pending', 'sent', 'read'],
      default: 'pending'
    },

    statusHistory: [
      {
        status: {
          type: String,
          enum: ['pending', 'sent', 'read']
        },
        at: {
          type: Date,
          default: Date.now
        }
      }
    ],

    // Delivery timestamp
    deliveredAt: {
      type: Date,
      default: null
    },

    // Message edit timestamp
    editedAt: {
      type: Date,
      default: null
    },

    // Delete message for everyone
    deletedForEveryone: {
      type: Boolean,
      default: false
    },

    deletedAt: {
      type: Date,
      default: null
    },

    // Delete message only for selected user
    deletedFor: [
      {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'User'
      }
    ]
  },
  {
    timestamps: true
  }
);

// Index for faster message retrieval
MessageSchema.index({
  sender: 1,
  receiver: 1,
  createdAt: -1
});

MessageSchema.index({
  receiver: 1,
  sender: 1,
  createdAt: -1
});

module.exports = mongoose.model('Message', MessageSchema);
