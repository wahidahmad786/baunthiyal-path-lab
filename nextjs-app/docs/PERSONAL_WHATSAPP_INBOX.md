# QR-linked WhatsApp inbox

Connecting a personal/mobile WhatsApp device now opens an inbox that can receive available one-to-one phone chat history and contact names, display earlier messages, start a conversation by number and send text replies through the real linked socket. Existing Meta API accounts keep their template/24-hour rules.

## User flow

After a new QR/pairing connection succeeds, the portal opens WhatsApp Inbox. Chats and names arrive from WhatsApp's history events; the Inbox shows progress only when a sync is active or needs attention; connection details stay in WhatsApp Integration. Existing linked devices created before history support request a phone sync when their saved socket reconnects.

Use the **Sync chats** button above the chat list while the phone is online to request history again. The request uses the protocol's full-history-on-demand operation directed at the user's own primary phone. Acceptance of this request is shown as requested, never as an invented completed import. The phone can decline it or not support it, especially for non-Business primary accounts. In that case use WhatsApp Integration → **Chat history did not arrive? → Re-link this device for chat history** and approve the same number again. Re-linking is an explicit owner action; it does not delete portal conversations or switch the account's connection method.

Use **+ / New WhatsApp chat** to choose a synced phone contact or enter a number with country code. Opening the conversation does not send anything or register a marketing customer. Type a message and choose Send. To attach a file, use the paperclip beside the composer, choose one supported file (up to 16 MB), then choose Send. Photos, MP4 video, common audio and documents are supported. Audio goes without a caption; send text separately. The backend records the request ID before contacting WhatsApp so an uncertain response does not automatically resend. Delivery ticks follow actual provider status. Phone history messages without a receipt stay unconfirmed.

## Storage and limits

Historical messages are encrypted with the existing server key, bound to the Google UID and conversation ID. They are compacted into private Firestore snapshots to avoid one database write for every imported message. Each chat retains up to 500 available recent messages within a 520 KB plaintext budget. History events process up to 500 individual chats per batch; the inbox lists the latest 500 conversations. Compressed history notifications over 8 MiB are not imported. The phone controls which historical messages it shares; this is not a promise to mirror an entire lifetime archive.

The API merges saved history with real portal/live messages, deduplicates provider IDs and pages 100 at a time. Imported records never create customer registrations, marketing consent, new unread events or historical STOP opt-outs. Provider unread counts on a newly imported chat are preserved. New live STOP messages retain their audited opt-out behavior.

The synced history is visible to the workspace owner and the team members they authorize. Only the owner may request full phone sync or re-link. Staff can use the shared inbox and open individual chats; viewers cannot send, start chats or request sync. Direct Firebase client reads of private history remain denied. Revocation is checked on every shared request.

Ordinary photos and stickers display inline; supported video and audio or voice notes have playback controls, and documents can be downloaded when WhatsApp supplies retrievable media. If a photo expired, an available embedded thumbnail may display instead. Earlier label-only messages can gain media on **Sync chats**, but only if the phone still shares the necessary data; otherwise request a resend. View-once and disappearing files are not made available. Attachment uploads do not change Meta Cloud API behavior. Contact avatars use the owner's linked session and respect WhatsApp visibility; initials or a default icon show if no preview is available. Calls, status, channels and group conversations are not part of this inbox.

History processing runs separately from the live message queue and publishes incremental progress. A history failure does not deliberately close a healthy socket. Five-second polling uses private revision checks, avoiding a complete re-read of all unchanged chats/messages on every refresh. Metadata changes invalidate the listing as well.

A running Node host and valid saved device credentials are still required. Hosting sleep, logout, device removal, unsupported phone sync and provider outages can interrupt availability. No paid hosting or database upgrade is enabled by this change.

## Validation

Unit checks cover receipt truthfulness, LID/phone routing, history message normalization, protocol exclusions and private/view-once content handling. Isolated Firebase Auth/Firestore emulator checks cover encrypted imports, deduplication, private reads, pagination (including tied timestamps), revision responses, new-chat behavior, request throttling and shared roles. Headless browser fixtures exercise sync, contact names, earlier messages, new-chat creation, one accepted fixture send, viewer restrictions and mobile layout. Real customer messages are not sent during automated tests.
