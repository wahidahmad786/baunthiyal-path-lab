import { NextRequest } from 'next/server';
import { cookies } from 'next/headers';
import { z } from 'zod';
import { randomBytes, createHmac } from 'node:crypto';
import { FieldValue } from 'firebase-admin/firestore';
import { auth, db, now, firebaseConfigured, bucket, publicOrigin } from '@/lib/server/firebase';
import {
  HttpError,
  errorResponse,
  requireStaff,
  requireMutation,
  checkOrigin,
} from '@/lib/server/auth';
import {
  col,
  createOffer,
  createCampaign,
  getCampaign,
  getOffer,
  audienceFor,
  statsFor,
  launch,
  runWorker,
  setConsent,
  rateLimit,
  publicCampaign,
  hash,
  constantEqual,
  sendTest,
  estimatedRate,
  nextId,
  applyDelivery,
} from '@/lib/server/service';
import { approvedTemplates, whatsappConfigured } from '@/lib/server/whatsapp';
import {
  campaignSchema,
  offerSchema,
  Customer,
  Campaign,
  Offer,
  normalizePhone,
  offerEligible,
  shouldUpdateDelivery,
} from '@/lib/domain';
import { makeExport, makeReceipt } from '@/lib/server/export';
import { requireWorker } from '@/lib/server/worker-auth';
import { verifyConnections } from '@/lib/server/setup';
import { hasLabAdminAccess } from '@/lib/access';
import { handleWhatsAppConnection } from '@/lib/whatsapp-connection-api';
import { handleAccountCatalog } from '@/lib/account-catalog-api';
import { handleAccountBanners } from '@/lib/account-banners-api';
import { handleAccountChat } from '@/lib/account-chat-api';
import { accountEnvironment } from '@/lib/server/account-environment';
import { handleAccountCustomers } from '@/lib/account-customers-api';
export const runtime = 'nodejs';
export const maxDuration = 300;
export const dynamic = 'force-dynamic';
type Context = { params: Promise<{ path: string[] }> };
const idSchema = z.string().regex(/^[a-zA-Z0-9_-]{1,150}$/);
function accountConnection(request: Request) {
  return handleWhatsAppConnection(request, accountEnvironment());
}
function accountCustomersRequest(request: Request) {
  return handleAccountCustomers(request, accountEnvironment());
}
function accountCatalogRequest(request: Request) {
  return handleAccountCatalog(request, accountEnvironment());
}
function accountInboxRequest(request: Request) {
  return handleAccountChat(request, accountEnvironment(true));
}
function accountBannerRequest(request: Request) {
  return handleAccountBanners(request, accountEnvironment(true));
}
async function body(request: Request) {
  const text = await request.text();
  if (text.length > 100000) throw new HttpError(413, 'Request is too large');
  return JSON.parse(text);
}
async function state() {
  const [campaignDocs, customerDocs, offerDocs, bookingDocs, tests, customerCount, optedCount] =
    await Promise.all([
      col('campaigns').orderBy('createdAt', 'desc').limit(100).get(),
      col('customers').orderBy('createdAt', 'desc').limit(1000).get(),
      col('offers').orderBy('createdAt', 'desc').limit(200).get(),
      col('bookings').orderBy('createdAt', 'desc').limit(200).get(),
      col('tests').get(),
      col('customers').count().get(),
      col('customers').where('marketing.status', '==', 'opted_in').count().get(),
    ]);
  const campaigns = await Promise.all(campaignDocs.docs.map((d) => statsFor(d.data() as Campaign)));
  return {
    campaigns,
    customers: customerDocs.docs.map((d) => ({ ...d.data(), id: d.id })),
    offers: offerDocs.docs.map((d) => d.data()),
    bookings: bookingDocs.docs.map((d) => ({ ...d.data(), id: d.id })),
    tests: tests.docs.map((d) => ({ ...d.data(), id: d.id })),
    totalCustomers: customerCount.data().count,
    optedIn: optedCount.data().count,
    limits: { campaigns: 100, customers: 1000, offers: 200, bookings: 200 },
  };
}
export async function GET(request: NextRequest, context: Context) {
  try {
    const p = (await context.params).path;
    const key = p.join('/');
    if (p[0] === 'account' && p[1] === 'banners') return accountBannerRequest(request);
    if (p[0] === 'account' && (p[1] === 'catalog' || p[1] === 'offers'))
      return accountCatalogRequest(request);
    if (p[0] === 'account' && p[1] === 'inbox') return accountInboxRequest(request);
    if (
      key === 'whatsapp/integration' ||
      key === 'whatsapp/integration/templates' ||
      key === 'whatsapp/integration/verification-token'
    )
      return accountConnection(request);
    if (
      key === 'account/customers' ||
      (p[0] === 'account' && p[1] === 'customers' && p[3] === 'consent')
    )
      return accountCustomersRequest(request);
    if (key === 'health')
      return Response.json({ status: 'ok', application: 'Baunthiyal Path Lab' });
    if (key === 'configuration')
      return Response.json({
        firebase: firebaseConfigured(),
        projectNumber: process.env.FIREBASE_PROJECT_NUMBER || '',
        whatsapp: whatsappConfigured(),
        rate: estimatedRate(),
        labPhone: process.env.LAB_PHONE || '',
        publicForms: (process.env.PUBLIC_RATE_LIMIT_SECRET?.length || 0) >= 32,
        cron: (process.env.CRON_SECRET?.length || 0) >= 32,
        clientAuth: !!process.env.NEXT_PUBLIC_FIREBASE_API_KEY,
        accountCustomers: !!process.env.NEXT_PUBLIC_FIREBASE_API_KEY,
        accountWhatsApp: !!process.env.NEXT_PUBLIC_FIREBASE_API_KEY,
        accountCatalog: !!process.env.NEXT_PUBLIC_FIREBASE_API_KEY,
        accountInbox: !!process.env.NEXT_PUBLIC_FIREBASE_API_KEY,
      });
    if (key.startsWith('public/offer/')) {
      const { campaign: c, offer } = await publicCampaign(p[2]);
      return Response.json({
        campaignId: c.id,
        offer: {
          id: offer.id,
          title: offer.title,
          description: offer.description,
          originalPrice: offer.originalPrice,
          offerPrice: offer.offerPrice,
          expiresAt: offer.expiresAt,
          eligibility: offer.eligibility,
        },
        labPhone: process.env.LAB_PHONE || '',
      });
    }
    if (key.startsWith('public/preferences/')) {
      const d = await col('preferenceTokens').doc(hash(p[2])).get();
      if (!d.exists || Date.parse(d.data()!.expiresAt) < Date.now())
        throw new HttpError(410, 'Preference link expired. Please contact the lab.');
      const c = await col('customers').doc(d.data()!.customerId).get();
      return Response.json({ status: c.data()?.marketing?.status || 'not_asked' });
    }
    if (key === 'webhook') {
      if (!process.env.WHATSAPP_VERIFY_TOKEN) throw new HttpError(503, 'Webhook not configured');
      if (
        request.nextUrl.searchParams.get('hub.mode') === 'subscribe' &&
        constantEqual(
          request.nextUrl.searchParams.get('hub.verify_token') || '',
          process.env.WHATSAPP_VERIFY_TOKEN,
        )
      ) {
        await col('integrationStatus')
          .doc('metaWebhook')
          .set({ challengeAnsweredAt: now() }, { merge: true });
        return new Response(request.nextUrl.searchParams.get('hub.challenge'));
      }
      throw new HttpError(403, 'Invalid verification token');
    }
    await requireStaff();
    if (key === 'state') return Response.json(await state());
    if (key === 'setup') return Response.json(await verifyConnections());
    if (key === 'templates') return Response.json({ templates: await approvedTemplates() });
    if (p[0] === 'campaigns' && p[2] === 'messages') {
      const c = await getCampaign(idSchema.parse(p[1]));
      const records = await col('campaigns').doc(c.id).collection('messages').get();
      return Response.json({ messages: records.docs.map((d) => ({ id: d.id, ...d.data() })) });
    }
    if (key === 'export') {
      const format = request.nextUrl.searchParams.get('format') === 'pdf' ? 'pdf' : 'xlsx';
      const s = await state();
      const bytes = await makeExport(s.campaigns, format);
      return new Response(new Uint8Array(bytes), {
        headers: {
          'Content-Type':
            format === 'pdf'
              ? 'application/pdf'
              : 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
          'Content-Disposition': `attachment; filename="BPL-campaign-results.${format}"`,
        },
      });
    }
    if (p[0] === 'jobs' && p[2] === 'receipt') {
      const d = await col('jobs').doc(idSchema.parse(p[1])).get();
      if (!d.exists) throw new HttpError(404, 'Job card not found');
      return new Response(new Uint8Array(await makeReceipt(d.data()!)), {
        headers: {
          'Content-Type': 'application/pdf',
          'Content-Disposition': `attachment; filename="${p[1]}-receipt.pdf"`,
        },
      });
    }
    throw new HttpError(404, 'Route not found');
  } catch (e) {
    return errorResponse(e);
  }
}
export async function POST(request: NextRequest, context: Context) {
  try {
    const p = (await context.params).path;
    const key = p.join('/');
    if (p[0] === 'account' && p[1] === 'banners') return accountBannerRequest(request);
    if (p[0] === 'account' && (p[1] === 'catalog' || p[1] === 'offers'))
      return accountCatalogRequest(request);
    if (p[0] === 'account' && p[1] === 'inbox') return accountInboxRequest(request);
    if (
      key === 'whatsapp/integration' ||
      key === 'whatsapp/integration/templates' ||
      key === 'whatsapp/integration/verification-token'
    )
      return accountConnection(request);
    if (
      key === 'account/customers' ||
      (p[0] === 'account' && p[1] === 'customers' && p[3] === 'consent')
    )
      return accountCustomersRequest(request);
    if (key === 'webhook') return await webhook(request);
    if (key === 'worker') {
      await requireWorker(request);
      return Response.json(await runWorker());
    }
    if (key === 'session') {
      checkOrigin(request);
      const { idToken } = z.object({ idToken: z.string().min(10) }).parse(await body(request));
      const claims = await auth().verifyIdToken(idToken, true);
      if (!hasLabAdminAccess(claims))
        throw new HttpError(403, 'An administrator account is required');
      if (Date.now() / 1000 - claims.auth_time > 300)
        throw new HttpError(401, 'Please sign in again');
      const expiresIn = 5 * 86400000;
      const session = await auth().createSessionCookie(idToken, { expiresIn });
      (await cookies()).set('bpl_session', session, {
        httpOnly: true,
        secure: process.env.NODE_ENV === 'production',
        sameSite: 'lax',
        path: '/',
        maxAge: expiresIn / 1000,
      });
      return Response.json({ ok: true });
    }
    if (key === 'logout') {
      checkOrigin(request);
      (await cookies()).delete('bpl_session');
      return Response.json({ ok: true });
    }
    if (key.startsWith('public/')) return await publicMutation(request, p);
    const actor = await requireMutation(request);
    if (key === 'offers')
      return Response.json(await createOffer(offerSchema.parse(await body(request))), {
        status: 201,
      });
    if (key === 'campaigns')
      return Response.json(
        await createCampaign(campaignSchema.parse(await body(request)), actor.uid),
        { status: 201 },
      );
    if (key === 'audience') {
      const input = campaignSchema.parse(await body(request));
      const audience = await audienceFor(input);
      return Response.json({
        count: audience.length,
        estimatedCost: estimatedRate() === null ? null : audience.length * estimatedRate()!,
      });
    }
    if (key === 'customers') {
      const input = z
        .object({
          name: z.string().trim().min(2).max(120),
          phone: z.string(),
          marketingConsent: z.boolean(),
          consentSource: z.string().trim().min(3).max(200),
          age: z.number().int().min(0).max(130).optional(),
          groups: z.array(z.string().max(80)).max(20).default([]),
        })
        .parse(await body(request));
      const phone = normalizePhone(input.phone);
      const id = hash(phone).slice(0, 32);
      await db().runTransaction(async (tx) => {
        const ref = col('customers').doc(id);
        if ((await tx.get(ref)).exists)
          throw new HttpError(
            409,
            'This customer already exists. Update their preferences instead.',
          );
        const marketing = {
          status: input.marketingConsent ? 'opted_in' : 'not_asked',
          source: input.consentSource,
          at: now(),
        };
        tx.create(ref, {
          id,
          name: input.name,
          phone,
          marketing,
          createdAt: now(),
          groups: input.groups,
          testIds: [],
          visits: 0,
          ...(input.age !== undefined ? { age: input.age } : {}),
        });
        tx.create(col('consentEvents').doc(), { customerId: id, ...marketing, actor: actor.uid });
      });
      return Response.json({ id }, { status: 201 });
    }
    if (key === 'tests') {
      const input = z
        .object({
          name: z.string().trim().min(2).max(120),
          price: z.number().int().positive(),
          type: z.enum(['test', 'package']),
        })
        .parse(await body(request));
      const ref = col('tests').doc();
      await ref.create({ ...input, createdAt: now() });
      return Response.json({ id: ref.id }, { status: 201 });
    }
    if (p[0] === 'customers' && p[2] === 'consent') {
      const input = z
        .object({
          status: z.enum(['opted_in', 'opted_out']),
          source: z.string().trim().min(5).max(200),
          confirmed: z.literal(true),
        })
        .parse(await body(request));
      await setConsent(idSchema.parse(p[1]), input.status, input.source, actor.uid);
      return Response.json({ ok: true });
    }
    if (key === 'banners') {
      const fd = await request.formData();
      const file = fd.get('file');
      if (!(file instanceof File) || file.size > 5 * 1024 * 1024)
        throw new HttpError(400, 'Upload a PNG or JPEG banner up to 5 MB');
      const bytes = Buffer.from(await file.arrayBuffer());
      const png = bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
      const jpeg = bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255;
      if (!png && !jpeg) throw new HttpError(400, 'Only PNG and JPEG images are accepted');
      const path = `campaign-banners/${randomBytes(16).toString('hex')}.${png ? 'png' : 'jpg'}`;
      await bucket()
        .file(path)
        .save(bytes, {
          metadata: {
            contentType: png ? 'image/png' : 'image/jpeg',
            cacheControl: 'private, max-age=3600',
          },
          resumable: false,
        });
      return Response.json({ path });
    }
    if (p[0] === 'campaigns') {
      const id = idSchema.parse(p[1]);
      const action = p[2];
      if (action === 'launch') {
        await launch(id);
        return Response.json({ ok: true });
      }
      if (action === 'test') {
        const input = z.object({ customerId: z.string().min(1) }).parse(await body(request));
        return Response.json(await sendTest(id, input.customerId));
      }
      if (action === 'pause' || action === 'resume') {
        await db().runTransaction(async (tx) => {
          const ref = col('campaigns').doc(id);
          const d = await tx.get(ref);
          const status = d.data()?.status;
          if (action === 'pause' && !['running', 'scheduled', 'preparing'].includes(status))
            throw new HttpError(409, 'This campaign cannot be paused');
          if (action === 'resume' && status !== 'paused')
            throw new HttpError(409, 'Only paused campaigns can resume');
          tx.update(ref, {
            status:
              action === 'pause' ? 'paused' : d.data()?.audienceSize ? 'preparing' : 'scheduled',
            updatedAt: now(),
          });
        });
        return Response.json({ ok: true });
      }
      if (action === 'retry') {
        const c = await getCampaign(id);
        if (!['completed', 'paused', 'running'].includes(c.status))
          throw new HttpError(409, 'Campaign cannot be retried');
        const messages = await col('campaigns')
          .doc(id)
          .collection('messages')
          .where('status', '==', 'failed')
          .get();
        let count = 0;
        for (const doc of messages.docs) {
          const m = doc.data();
          if (
            (m.attempts || 0) >= 3 ||
            ![4, 80007, 130429, 131048, 131056, 131000].includes(m.metaCode)
          )
            continue;
          await db().runTransaction(async (tx) => {
            const cur = await tx.get(doc.ref);
            if (cur.data()?.status === 'failed') {
              tx.update(doc.ref, { status: 'queued' });
              count++;
            }
          });
        }
        if (count)
          await col('campaigns').doc(id).update({
            status: 'paused',
            lastError: 'Transient failures requeued. Resume when account limits allow.',
          });
        return Response.json({ count });
      }
      if (!action) {
        const input = campaignSchema.parse(await body(request));
        await getOffer(input.offerId);
        await db().runTransaction(async (tx) => {
          const ref = col('campaigns').doc(id);
          const c = await tx.get(ref);
          if (c.data()?.status !== 'draft') throw new HttpError(409, 'Only drafts can be edited');
          tx.update(ref, { ...input, updatedAt: now() });
        });
        return Response.json({ ok: true });
      }
    }
    if (p[0] === 'bookings' && p[2] === 'job') {
      const id = idSchema.parse(p[1]);
      const input = z.object({ customerId: z.string().min(1) }).parse(await body(request));
      const bookingRef = col('bookings').doc(id);
      const b = (await bookingRef.get()).data();
      if (!b) throw new HttpError(404, 'Booking not found');
      const offer = await getOffer(b.offerId);
      const jobId = await nextId('jobs', 'BPL-JOB');
      await db().runTransaction(async (tx) => {
        const [bs, cs] = await tx.getAll(bookingRef, col('customers').doc(input.customerId));
        const booking = bs.data()!;
        const customer = cs.data() as Customer | undefined;
        if (booking.jobId) throw new HttpError(409, 'A job card already exists');
        if (!customer || normalizePhone(customer.phone) !== booking.phone)
          throw new HttpError(400, 'Select the registered customer with the booking phone number');
        if (
          Date.parse(offer.expiresAt) < Date.now() ||
          Date.parse(offer.startsAt) > Date.now() ||
          !offerEligible(offer, customer)
        )
          throw new HttpError(400, 'Offer is expired or customer is ineligible');
        tx.create(col('jobs').doc(jobId), {
          id: jobId,
          customerId: input.customerId,
          customerName: customer.name,
          phone: customer.phone,
          campaignId: b.campaignId,
          offerId: offer.id,
          testIds: offer.testIds,
          originalPrice: offer.originalPrice,
          discount: offer.originalPrice - offer.offerPrice,
          total: offer.offerPrice,
          paid: 0,
          status: 'registered',
          createdAt: now(),
          createdBy: actor.uid,
        });
        tx.update(bookingRef, { status: 'confirmed', jobId });
        tx.update(col('customers').doc(input.customerId), {
          lastVisitAt: now(),
          visits: FieldValue.increment(1),
          testIds: [...new Set([...(customer.testIds || []), ...offer.testIds])],
        });
        tx.update(col('offers').doc(offer.id), { usedCount: FieldValue.increment(1) });
      });
      return Response.json({ jobId });
    }
    if (p[0] === 'jobs' && p[2] === 'payments') {
      const id = idSchema.parse(p[1]);
      const input = z
        .object({
          amount: z.number().int().positive(),
          method: z.enum(['cash', 'upi', 'card', 'bank']),
          reference: z.string().trim().min(3).max(150),
        })
        .parse(await body(request));
      const receiptId = hash(`${id}:${input.reference}`);
      await db().runTransaction(async (tx) => {
        const ref = col('jobs').doc(id);
        const [job, existing] = await tx.getAll(ref, col('payments').doc(receiptId));
        if (existing.exists)
          throw new HttpError(409, 'This payment reference was already recorded');
        const j = job.data();
        if (!j) throw new HttpError(404, 'Job not found');
        if (input.amount > j.total - j.paid)
          throw new HttpError(400, 'Payment exceeds outstanding balance');
        tx.create(col('payments').doc(receiptId), {
          ...input,
          jobId: id,
          campaignId: j.campaignId,
          createdAt: now(),
          recordedBy: actor.uid,
        });
        tx.update(ref, { paid: FieldValue.increment(input.amount) });
      });
      return Response.json({ receiptId });
    }
    throw new HttpError(404, 'Route not found');
  } catch (e) {
    return errorResponse(e);
  }
}
async function publicMutation(request: Request, p: string[]) {
  checkOrigin(request);
  if (p[1] === 'book') {
    await rateLimit(request, 'booking', 5);
    const input = z
      .object({
        name: z.string().trim().min(2).max(120),
        phone: z.string(),
        marketingConsent: z.boolean().default(false),
        website: z.literal('').default(''),
      })
      .parse(await body(request));
    const { campaign, offer } = await publicCampaign(p[2]);
    const phone = normalizePhone(input.phone);
    const bookingId = hash(`${campaign.id}:${phone}`);
    await db().runTransaction(async (tx) => {
      const ref = col('bookings').doc(bookingId);
      if ((await tx.get(ref)).exists)
        throw new HttpError(409, 'Your booking request is already with the lab');
      tx.create(ref, {
        id: bookingId,
        campaignId: campaign.id,
        offerId: offer.id,
        name: input.name,
        phone,
        createdAt: now(),
        status: 'requested',
        marketingRequested: input.marketingConsent,
      });
      tx.create(col('notifications').doc(), {
        type: 'booking_request',
        campaignId: campaign.id,
        bookingId,
        read: false,
        createdAt: now(),
      });
      // A checkbox is recorded as an unverified request. Staff verify phone ownership before applying consent.
      if (input.marketingConsent)
        tx.create(col('consentRequests').doc(), {
          bookingId,
          phone,
          source: 'public_booking_checkbox',
          at: now(),
          status: 'pending_phone_verification',
        });
    });
    return Response.json({ ok: true }, { status: 201 });
  }
  if (p[1] === 'preferences') {
    await rateLimit(request, 'preferences', 20);
    const input = z
      .object({ status: z.enum(['opted_in', 'opted_out']), consent: z.literal(true) })
      .parse(await body(request));
    const tokenRef = col('preferenceTokens').doc(hash(p[2]));
    const token = (await tokenRef.get()).data();
    if (!token || Date.parse(token.expiresAt) < Date.now())
      throw new HttpError(410, 'Preference link expired');
    await setConsent(token.customerId, input.status, 'signed_preference_link', 'customer');
    return Response.json({ ok: true });
  }
  throw new HttpError(404, 'Route not found');
}
async function webhook(request: Request) {
  const secret = process.env.WHATSAPP_APP_SECRET;
  if (!secret) throw new HttpError(503, 'Webhook not configured');
  const raw = await request.text();
  if (raw.length > 2000000) throw new HttpError(413, 'Payload too large');
  const expected = 'sha256=' + createHmac('sha256', secret).update(raw).digest('hex');
  if (!constantEqual(request.headers.get('x-hub-signature-256') || '', expected))
    throw new HttpError(401, 'Invalid webhook signature');
  await col('integrationStatus')
    .doc('metaWebhook')
    .set({ lastSignedWebhookAt: now() }, { merge: true });
  const payload = JSON.parse(raw);
  if (payload.object !== 'whatsapp_business_account')
    throw new HttpError(400, 'Unexpected webhook object');
  for (const entry of payload.entry || []) {
    for (const change of entry.changes || []) {
      const value = change.value || {};
      if (value.metadata?.phone_number_id !== process.env.WHATSAPP_PHONE_NUMBER_ID) continue;
      for (const status of value.statuses || []) {
        if (!['sent', 'delivered', 'read', 'failed'].includes(status.status)) continue;
        await applyDelivery(status);
      }
      for (const message of value.messages || []) {
        const phone = normalizePhone(message.from);
        const eventRef = col('webhookEvents').doc(hash(message.id));
        const text = (
          message.text?.body ||
          message.button?.text ||
          message.interactive?.button_reply?.title ||
          ''
        ).trim();
        const stop = /^(stop|unsubscribe|cancel|opt\s?out|stop promotions)$/i.test(text);
        const customers = await col('customers').where('phone', '==', phone).get();
        await db().runTransaction(async (tx) => {
          const event = await tx.get(eventRef);
          if (event.exists) return;
          const attributionRef = col('contactAttribution').doc(hash(phone));
          const attributed = await tx.get(attributionRef);
          tx.create(eventRef, { kind: stop ? 'opt_out' : 'response', at: now() });
          for (const customer of customers.docs) {
            if (stop) {
              const consent = { status: 'opted_out', at: now(), source: 'whatsapp_stop' };
              tx.update(customer.ref, { marketing: consent });
              tx.create(col('consentEvents').doc(), {
                customerId: customer.id,
                ...consent,
                actor: 'customer',
              });
            }
          }
          const campaignId = attributed.data()?.campaignId;
          if (campaignId && Date.parse(attributed.data()!.at) > Date.now() - 30 * 86400000)
            tx.create(col('responses').doc(hash(message.id)), {
              campaignId,
              kind: stop ? 'opt_out' : 'response',
              at: now(),
            });
        });
      }
    }
  }
  return Response.json({ received: true });
}
