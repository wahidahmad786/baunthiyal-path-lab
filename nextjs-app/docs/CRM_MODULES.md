# Template Manager, connection alerts and team inbox

Implemented in the existing Next.js Render portal. The legacy `hosted-portal/` Worker snapshot is not updated by this release. Existing customer, catalog, offer, campaign, consent, callback and message-delivery behavior remains in place.

## Template Manager

Open **Template Manager** after signing in. Save and edit private drafts, choose English/Hindi, select Marketing or Utility, and use a fixed text or image header. The image uses the existing owned Firestore banner storage; submission performs a real Meta resumable upload and uses Meta’s returned sample handle.

The body supports numbered variables with example values for Meta review. Marketing submissions require the lab identity, tagline and Reply STOP instruction. A draft is editable before submission. Duplicate a submitted draft to prepare another template.

**Submit to Meta** uses the saved account’s real WhatsApp Business Account and Graph API. A successful submission is not approval and does not send any customer messages. **Refresh Meta status** reads the provider’s real templates, categories, approvals, rejection status and deletion state. Existing campaign sending still loads approved supported templates through the original account template endpoint.

Concurrent submit attempts are protected by database compare-and-set writes. A lost response, malformed success response or ambiguous provider failure leaves the submission unconfirmed. Refreshing Meta status can reconcile it with the provider’s actual record. The application does not blindly resubmit an unconfirmed creation or fabricate an approved template. Failed submissions update the form’s saved revision so the owner can continue editing.

## Automatic connection alerts

The authenticated header notification bell performs a server-side check on load and every five minutes while the portal is open and visible. Checks include token/app validity, available messaging permissions, token/data-access expiry, phone access, the actual WABA app subscription and saved signed callback readiness.

Results and alerts persist in Firestore. Checks are cached for five minutes, failed checks retry after a shorter cache period, and a database lease prevents duplicate provider checks from concurrent tabs. Manual checks have a short cooldown. Expiry within seven days creates a warning; invalid/revoked access creates an error. Provider unavailability is recorded as unknown, preserving unresolved authorization alerts. Acknowledging an alert changes its notification state, not the actual connection. Booking notifications remain available in the same bell.

This is dashboard monitoring, not a 24/7 out-of-browser worker or email/WhatsApp alert service. No paid host, queue, scheduler or billing upgrade was enabled. The free Render plan can still sleep when idle.

## Team access and collaboration

Open **Team & quick replies** to create a private invitation for a verified email. The owner shares the generated link; the system does not send invitation emails. Invites expire after 48 hours and can only be accepted once by the matching verified Firebase identity. Sign-in preserves the internal invite return path without permitting external redirects.

Each Google login still owns its own independent WhatsApp workspace. Accepted members can select an explicitly shared inbox without receiving the owner’s Meta credentials or access to the owner’s catalog, payments, customer-registration APIs or templates.

Roles:

- **Owner:** invite/remove members, manage quick replies, read/reply, assign chats, change labels/status and add internal notes.
- **Staff:** read/reply, assign to active owner/staff members, change labels/status and add notes in the shared inbox.
- **Viewer:** read conversations and notes. Server endpoints reject replies, notes, assignments, invitations and quick-reply management for this role.

Membership is checked on every inbox request. The membership index is not an authorization grant. Removing a member immediately revokes API access, removes the index entry and revokes outstanding invitations. Invites older than a newer membership grant/removal cannot restore an earlier role.

The inbox supports assignment, labels, open/resolved state, assigned-to-me/status/label filters, internal notes and quick replies. Notes stay private to authorized team members and are never sent to customers. Inserting a quick reply fills the composer; it does not send it. Team replies use the owner’s connected API number and retain the actual 24-hour customer reply-window and send-idempotency checks.

## Storage and deployment

All new data is under the authenticated owner’s `bpl_customerWorkspaces/{uid}` namespace:

- `templateDrafts`, `templateRecords`, `templateSync`
- `integrationHealth`, `connectionAlerts`
- `teamMembers`, `teamInvites`, `teamProfile`, `teamAccess`, `quickReplies`
- `conversationMeta`, `conversationNotes/{id}/entries`

These collections use the existing trusted datastore service identity. Existing deny-by-default Firestore rules prevent direct client access or forged writes; no rule expansion, custom composite index, credential rotation or data migration is required. APIs verify Firebase identity, workspace membership, role, input and mutation origin before accessing or changing private records. Private credentials and raw Meta error messages never cross the API boundary.

Deployment uses the existing Render service and its current runtime settings. Valid saved Meta credentials/permissions are required for provider operations. Embedded Signup’s separate portal-owner configuration and Meta approval requirements are unchanged by this release. The new modules do not claim to activate incomplete account onboarding.

## Validation

- 44 unit tests passed.
- 38 focused Auth/Firestore emulator tests passed, including 15 new CRM workflow/security tests alongside original chat, template and Embedded Signup regressions.
- Production build and TypeScript validation passed.
- Headless Chromium exercised image upload/preview, draft saving and error recovery, provider-submit/status controls, team invitations, assignment/notes, quick replies without automatic sending, workspace switching, viewer restrictions, notifications and mobile layouts.
- Provider calls in tests were isolated fixtures. No live customer message, real Meta template submission or invitation email was sent during implementation.

## Official API references

- [WhatsApp template create/list API](https://developers.facebook.com/docs/graph-api/reference/whats-app-business-account/message_templates/)
- [Meta resumable file upload](https://developers.facebook.com/documentation/video-api/graph-api/guides/upload)
