import 'server-only';
import { randomBytes, createHash, timingSafeEqual, createHmac } from 'node:crypto';
import { FieldValue } from 'firebase-admin/firestore';
import { db, now, publicOrigin, bucket } from './firebase';
import { HttpError } from './auth';
import {
  Campaign,
  CampaignInput,
  Customer,
  Offer,
  OfferInput,
  eligible,
  offerEligible,
  finalPrice,
  normalizePhone,
  Template,
  shouldUpdateDelivery,
} from '../domain';
import { money } from '../brand';
import { approvedTemplates, validateTemplate, sendTemplate, MetaError } from './whatsapp';
export const col = (name: string) => db().collection(`bpl_${name}`);
export const hash = (v: string) => createHash('sha256').update(v).digest('hex');
export const secretToken = () => randomBytes(24).toString('base64url');
export function constantEqual(a: string, b: string) {
  const x = Buffer.from(a),
    y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}
export function estimatedRate() {
  const value = Number(process.env.WHATSAPP_MARKETING_RATE_PAISE);
  return process.env.WHATSAPP_MARKETING_RATE_PAISE && Number.isFinite(value) && value > 0
    ? Math.ceil(value)
    : null;
}
export async function nextId(kind: string, prefix: string) {
  return db().runTransaction(async (tx) => {
    const ref = col('counters').doc(kind);
    const d = await tx.get(ref);
    const n = (d.data()?.value || 0) + 1;
    tx.set(ref, { value: n });
    return `${prefix}-${String(n).padStart(4, '0')}`;
  });
}
export async function createOffer(input: OfferInput) {
  const tests = await db().getAll(...input.testIds.map((id) => col('tests').doc(id)));
  if (tests.some((d) => !d.exists) || new Set(input.testIds).size !== input.testIds.length)
    throw new HttpError(400, 'Choose valid, unique tests or packages from the catalog');
  const id = await nextId('offers', 'BPL-OFFER');
  const offer: Offer = {
    ...input,
    id,
    offerPrice: finalPrice(input.originalPrice, input.discountType, input.discountValue),
    createdAt: now(),
    usedCount: 0,
  };
  await col('offers').doc(id).create(offer);
  return offer;
}
export async function getOffer(id: string) {
  const d = await col('offers').doc(id).get();
  if (!d.exists) throw new HttpError(404, 'Offer not found');
  return d.data() as Offer;
}
export async function getCampaign(id: string) {
  const d = await col('campaigns').doc(id).get();
  if (!d.exists) throw new HttpError(404, 'Campaign not found');
  return d.data() as Campaign;
}
export async function createCampaign(input: CampaignInput, uid: string) {
  await getOffer(input.offerId);
  const id = await nextId('campaigns', 'BPL-CMP');
  const c: Campaign = {
    ...input,
    id,
    status: 'draft',
    createdAt: now(),
    updatedAt: now(),
    trackingToken: secretToken(),
    audienceSize: 0,
    processed: 0,
    sent: 0,
    delivered: 0,
    read: 0,
    failed: 0,
    unknown: 0,
    spend: 0,
    responses: 0,
    bookings: 0,
    confirmed: 0,
    revenue: 0,
  };
  const batch = db().batch();
  batch.create(col('campaigns').doc(id), { ...c, createdBy: uid });
  batch.create(col('tracking').doc(c.trackingToken), { campaignId: id });
  await batch.commit();
  return c;
}
export async function audienceFor(c: CampaignInput) {
  const snap = await col('customers')
    .where('marketing.status', '==', 'opted_in')
    .limit(10001)
    .get();
  if (snap.size > 10000)
    throw new HttpError(
      422,
      'This installation supports audience evaluation for up to 10,000 opted-in customers. Add indexed audience pagination before continuing.',
    );
  const offer = await getOffer(c.offerId);
  return snap.docs
    .map((d) => ({ ...d.data(), id: d.id }) as Customer)
    .filter((v) => eligible(v, c.audience) && offerEligible(offer, v));
}
export async function statsFor(c: Campaign) {
  const [ms, bs, ps, rs] = await Promise.all([
    col('campaigns').doc(c.id).collection('messages').get(),
    col('bookings').where('campaignId', '==', c.id).get(),
    col('payments').where('campaignId', '==', c.id).get(),
    col('responses').where('campaignId', '==', c.id).count().get(),
  ]);
  const messages = ms.docs.map((d) => d.data());
  return {
    ...c,
    processed: messages.filter((m) => !['queued', 'sending'].includes(m.status)).length,
    sent: messages.filter((m) => m.metaId).length,
    delivered: messages.filter((m) => ['delivered', 'read'].includes(m.status)).length,
    read: messages.filter((m) => m.status === 'read').length,
    failed: messages.filter((m) => m.status === 'failed').length,
    unknown: messages.filter((m) => m.status === 'unknown').length,
    spend: messages.reduce((s, m) => s + (m.deliveredAt ? m.estimatedCost || 0 : 0), 0),
    responses: rs.data().count,
    bookings: bs.size,
    confirmed: bs.docs.filter((d) => d.data().status === 'confirmed').length,
    revenue: ps.docs.reduce((s, d) => s + (d.data().amount || 0), 0),
  };
}
export async function launch(id: string) {
  const c = await getCampaign(id);
  const offer = await getOffer(c.offerId);
  if (Date.parse(offer.expiresAt) <= Date.now()) throw new HttpError(400, 'The offer has expired');
  if (c.scheduledAt && Date.parse(c.scheduledAt) >= Date.parse(offer.expiresAt))
    throw new HttpError(400, 'Schedule must precede offer expiry');
  const templates = await approvedTemplates();
  const template = templates.find((t) => t.id === c.templateId);
  if (!template) throw new HttpError(400, 'Choose an approved marketing template');
  validateTemplate(template, c.variables, c.bannerPath);
  if (!process.env.LAB_PHONE || !estimatedRate())
    throw new HttpError(503, 'Configure the lab phone and estimated marketing message rate');
  const audience = await audienceFor(c);
  if (!audience.length)
    throw new HttpError(400, 'No eligible opted-in customers match this audience');
  if (audience.length > 1000)
    throw new HttpError(400, 'Limit each campaign to 1,000 recipients using a customer group');
  await db().runTransaction(async (tx) => {
    const ref = col('campaigns').doc(id);
    const current = await tx.get(ref);
    if (current.data()?.status !== 'draft') throw new HttpError(409, 'Only drafts can be launched');
    tx.update(ref, {
      status: 'scheduled',
      approvedTemplate: template,
      audienceSize: audience.length,
      updatedAt: now(),
      scheduledAt: c.scheduledAt || now(),
    });
  });
}
async function preferenceLink(customerId: string) {
  const token = secretToken();
  await col('preferenceTokens')
    .doc(hash(token))
    .create({ customerId, expiresAt: new Date(Date.now() + 90 * 86400000).toISOString() });
  return `${publicOrigin()}/preferences/${token}`;
}
async function messageValues(c: Campaign, customer: Customer, offer: Offer) {
  const values: Record<string, string> = {
    customer_name: customer.name,
    offer_title: offer.title,
    original_price: money(offer.originalPrice),
    offer_price: money(offer.offerPrice),
    expiry_date: new Date(offer.expiresAt).toLocaleDateString('en-IN', {
      timeZone: 'Asia/Kolkata',
    }),
    lab_phone: process.env.LAB_PHONE || '',
    booking_link: `${publicOrigin()}/book/${c.trackingToken}`,
    preferences_link: Object.values(c.variables).includes('preferences_link')
      ? await preferenceLink(customer.id)
      : '',
  };
  return Object.fromEntries(
    Object.entries(c.variables).map(([key, value]) => [key, values[value]]),
  );
}
async function bannerUrl(path: string) {
  if (!path) return undefined;
  if (!/^campaign-banners\/[a-zA-Z0-9_.-]+$/.test(path))
    throw new HttpError(400, 'Invalid banner path');
  const [url] = await bucket()
    .file(path)
    .getSignedUrl({ action: 'read', expires: Date.now() + 3600000 });
  return url;
}
async function reserveQuota(messageKey: string) {
  const day = now().slice(0, 10);
  const ref = col('quotas').doc('rolling24h');
  const limit = Math.min(
    10000,
    Math.max(1, Math.floor(Number(process.env.WHATSAPP_DAILY_LIMIT) || 1000)),
  );
  await db().runTransaction(async (tx) => {
    const [q, cooldown] = await tx.getAll(ref, col('locks').doc('provider-cooldown'));
    if ((cooldown.data()?.until || 0) > Date.now())
      throw new HttpError(429, 'Provider sending cooldown is active');
    const recent = (q.data()?.timestamps || []).filter((at: number) => at > Date.now() - 86400000);
    if (recent.length >= limit)
      throw new HttpError(429, 'Rolling 24-hour sending allowance reached');
    tx.set(ref, {
      count: recent.length + 1,
      timestamps: [...recent, Date.now()],
      updatedAt: now(),
    });
    tx.set(col('quotaReservations').doc(messageKey), { day, at: now() });
  });
}
export async function sendTest(id: string, customerId: string) {
  const c = await getCampaign(id);
  const d = await col('customers').doc(customerId).get();
  const customer = d.data() as Customer | undefined;
  if (!customer || customer.marketing?.status !== 'opted_in')
    throw new HttpError(400, 'The test recipient must be an opted-in customer');
  const template = (await approvedTemplates()).find((t) => t.id === c.templateId);
  if (!template) throw new HttpError(400, 'Choose an approved template first');
  validateTemplate(template, c.variables, c.bannerPath);
  if (!estimatedRate()) throw new HttpError(503, 'Configure the marketing rate before sending');
  const values = await messageValues(c, { ...customer, id: customerId }, await getOffer(c.offerId));
  const image = await bannerUrl(c.bannerPath);
  const latest = (await col('customers').doc(customerId).get()).data() as Customer | undefined;
  if (latest?.marketing?.status !== 'opted_in')
    throw new HttpError(400, 'Customer opted out before the test send');
  const ref = col('testMessages').doc();
  await reserveQuota(ref.id);
  await ref.set({ campaignId: id, customerId, status: 'sending', createdAt: now() });
  try {
    const metaId = await sendTemplate(customer.phone, template, values, image);
    await ref.update({ metaId, status: 'accepted' });
    await col('messageIndex')
      .doc(hash(metaId))
      .set({ path: ref.path, metaId, campaignId: id, customerId, isTest: true });
    return { metaId };
  } catch (e) {
    await ref.update({ status: e instanceof MetaError ? 'failed' : 'unknown' });
    throw e;
  }
}
async function prepare(id: string) {
  const c = await getCampaign(id);
  const offer = await getOffer(c.offerId);
  if (Date.parse(offer.expiresAt) <= Date.now()) {
    await col('campaigns').doc(id).update({ status: 'expired' });
    return;
  }
  const saved = (await col('campaigns').doc(id).get()).data()!;
  let customers: Customer[];
  if (Array.isArray(saved.frozenCustomerIds)) {
    customers = saved.frozenCustomerIds.length
      ? (
          await db().getAll(
            ...(saved.frozenCustomerIds as string[]).map((customerId) =>
              col('customers').doc(customerId),
            ),
          )
        )
          .filter((d) => d.exists)
          .map((d) => ({ ...d.data(), id: d.id }) as Customer)
      : [];
  } else {
    customers = await audienceFor(c);
    if (customers.length <= 1000)
      await col('campaigns')
        .doc(id)
        .update({ frozenCustomerIds: customers.map((v) => v.id) });
  }
  if (customers.length > 1000)
    throw new HttpError(
      422,
      'Audience grew beyond 1,000. Create a new campaign targeting a narrower group',
    );
  for (let i = 0; i < customers.length; i += 200) {
    await db().runTransaction(async (tx) => {
      const chunk = customers.slice(i, i + 200);
      const refs = chunk.map((v) => col('campaigns').doc(id).collection('messages').doc(v.id));
      const existing = await tx.getAll(...refs);
      chunk.forEach((v, j) => {
        if (!existing[j].exists)
          tx.create(refs[j], {
            customerId: v.id,
            status: 'queued',
            createdAt: now(),
            attempts: 0,
            estimatedCost: estimatedRate(),
          });
      });
    });
  }
  await db().runTransaction(async (tx) => {
    const ref = col('campaigns').doc(id);
    const cur = await tx.get(ref);
    if (cur.data()?.status === 'preparing')
      tx.update(ref, { status: 'running', audienceSize: customers.length, updatedAt: now() });
  });
}
export async function runWorker() {
  const cooldown = await col('locks').doc('provider-cooldown').get();
  if ((cooldown.data()?.until || 0) > Date.now()) return { providerLimited: true };
  const leaseRef = col('locks').doc('campaign-worker');
  const owner = secretToken();
  const acquired = await db().runTransaction(async (tx) => {
    const l = await tx.get(leaseRef);
    if ((l.data()?.until || 0) > Date.now()) return false;
    tx.set(leaseRef, { owner, until: Date.now() + 300000 });
    return true;
  });
  if (!acquired) return { busy: true };
  const batchLimit = Math.min(
    25,
    Math.max(1, Math.floor(Number(process.env.WHATSAPP_BATCH_SIZE) || 20)),
  );
  let processed = 0;
  try {
    await col('workerStatus').doc('latest').set({ startedAt: now() });
    await reconcileStatuses();
    const cs = await col('campaigns')
      .where('status', 'in', ['scheduled', 'preparing', 'running'])
      .get();
    for (const doc of cs.docs) {
      let c = doc.data() as Campaign;
      if (c.status === 'scheduled' && Date.parse(c.scheduledAt!) > Date.now()) continue;
      if (c.status === 'scheduled') {
        const transitioned = await db().runTransaction(async (tx) => {
          const current = await tx.get(doc.ref);
          if (current.data()?.status !== 'scheduled') return false;
          tx.update(doc.ref, { status: 'preparing' });
          return true;
        });
        if (!transitioned) continue;
        c.status = 'preparing';
      }
      if (c.status === 'preparing') {
        try {
          await prepare(c.id);
        } catch (e) {
          await doc.ref.update({
            status: 'paused',
            lastError: e instanceof Error ? e.message : 'Audience preparation failed',
          });
          continue;
        }
      }
      c = await getCampaign(c.id);
      if (c.status !== 'running') continue;
      const offer = await getOffer(c.offerId);
      if (Date.parse(offer.expiresAt) <= Date.now()) {
        await doc.ref.update({ status: 'expired' });
        continue;
      }
      if (Date.parse(offer.startsAt) > Date.now()) continue;
      const template = (await approvedTemplates()).find((t) => t.id === c.templateId);
      if (!template) {
        await doc.ref.update({ status: 'paused', lastError: 'Template is no longer approved' });
        continue;
      }
      validateTemplate(template, c.variables, c.bannerPath);
      const queued = await doc.ref
        .collection('messages')
        .where('status', '==', 'queued')
        .limit(batchLimit - processed)
        .get();
      for (const m of queued.docs) {
        if (Date.now() + 25000 > (await leaseRef.get()).data()!.until) break;
        const claimed = await db().runTransaction(async (tx) => {
          const [cur, cam, customerDoc, lease] = await tx.getAll(
            m.ref,
            doc.ref,
            col('customers').doc(m.id),
            leaseRef,
          );
          if (lease.data()?.owner !== owner || lease.data()!.until <= Date.now()) return null;
          const customer = customerDoc.data() as Customer | undefined;
          if (cam.data()?.status !== 'running' || cur.data()?.status !== 'queued') return null;
          if (
            !customer ||
            !eligible({ ...customer, id: m.id }, c.audience) ||
            !offerEligible(offer, customer)
          ) {
            tx.update(m.ref, {
              status: 'skipped',
              reason: 'Customer no longer eligible or opted in',
            });
            return null;
          }
          tx.update(m.ref, {
            status: 'sending',
            claimedAt: now(),
            attempts: FieldValue.increment(1),
          });
          return { ...customer, id: m.id };
        });
        if (!claimed) continue;
        try {
          await reserveQuota(hash(m.ref.path + String(m.data().attempts)));
        } catch (e) {
          await m.ref.update({ status: 'queued' });
          return { processed, limited: true };
        }
        processed++;
        try {
          const values = await messageValues(c, claimed, offer);
          const image = await bannerUrl(c.bannerPath);
          const latest = (await col('customers').doc(m.id).get()).data() as Customer;
          const latestCampaign = await getCampaign(c.id);
          if (!latest || latest.marketing?.status !== 'opted_in') {
            await m.ref.update({ status: 'skipped', reason: 'Opted out before send' });
            continue;
          }
          if (latestCampaign.status !== 'running') {
            await m.ref.update({ status: 'queued' });
            continue;
          }
          const metaId = await sendTemplate(normalizePhone(claimed.phone), template, values, image);
          const batch = db().batch();
          batch.update(m.ref, { status: 'accepted', metaId, sentAt: now() });
          batch.set(col('messageIndex').doc(hash(metaId)), {
            path: m.ref.path,
            metaId,
            campaignId: c.id,
            customerId: m.id,
          });
          batch.set(col('contactAttribution').doc(hash(claimed.phone)), {
            campaignId: c.id,
            metaId,
            at: now(),
          });
          await batch.commit();
        } catch (e) {
          await m.ref.update({
            status: e instanceof MetaError ? 'failed' : 'unknown',
            error:
              e instanceof MetaError
                ? e.message
                : 'Send outcome is uncertain. Reconcile with Meta before retrying.',
            failedAt: now(),
            metaCode: e instanceof MetaError ? e.code : null,
          });
          if (
            e instanceof MetaError &&
            (e.status === 429 || [4, 80007, 130429, 131048, 131056].includes(e.code))
          ) {
            await col('locks')
              .doc('provider-cooldown')
              .set({ until: Date.now() + 3600000 });
            await doc.ref.update({ status: 'paused', lastError: e.message });
            return { processed, providerLimited: true };
          }
        }
        if (processed >= batchLimit) break;
      }
      // A crashed or timed-out send is never automatically resent: Meta has no idempotency guarantee.
      const stale = await doc.ref.collection('messages').where('status', '==', 'sending').get();
      for (const m of stale.docs)
        if (Date.parse(m.data().claimedAt) < Date.now() - 300000)
          await m.ref.update({
            status: 'unknown',
            error: 'Worker interrupted; reconcile with Meta before retrying',
          });
      const remaining = await doc.ref
        .collection('messages')
        .where('status', 'in', ['queued', 'sending'])
        .count()
        .get();
      if (!remaining.data().count)
        await db().runTransaction(async (tx) => {
          const cur = await tx.get(doc.ref);
          if (cur.data()?.status === 'running')
            tx.update(doc.ref, { status: 'completed', updatedAt: now() });
        });
      if (processed >= batchLimit) break;
    }
    await col('workerStatus').doc('latest').set({ completedAt: now(), processed }, { merge: true });
    return { processed };
  } finally {
    await db().runTransaction(async (tx) => {
      const l = await tx.get(leaseRef);
      if (l.data()?.owner === owner) tx.delete(leaseRef);
    });
  }
}
export async function setConsent(
  customerId: string,
  status: 'opted_in' | 'opted_out',
  source: string,
  actor: string,
) {
  await db().runTransaction(async (tx) => {
    const ref = col('customers').doc(customerId);
    const d = await tx.get(ref);
    if (!d.exists) throw new HttpError(404, 'Customer not found');
    const consent = { status, at: now(), source };
    tx.update(ref, { marketing: consent });
    tx.create(col('consentEvents').doc(), { customerId, ...consent, actor });
  });
}
export async function rateLimit(request: Request, key: string, max = 5) {
  const secret = process.env.PUBLIC_RATE_LIMIT_SECRET;
  if (!secret || secret.length < 32)
    throw new HttpError(503, 'Public forms need rate-limit configuration');
  // The deployment proxy must overwrite x-forwarded-for; never trust a client supplied chain.
  const ip = request.headers.get('x-forwarded-for')?.split(',')[0]?.trim() || 'unknown';
  const window = Math.floor(Date.now() / 3600000);
  const id = createHmac('sha256', secret).update(`${key}:${ip}:${window}`).digest('hex');
  await db().runTransaction(async (tx) => {
    const ref = col('rateLimits').doc(id);
    const d = await tx.get(ref);
    if ((d.data()?.count || 0) >= max)
      throw new HttpError(429, 'Too many requests. Please try again later.');
    tx.set(ref, { count: (d.data()?.count || 0) + 1, expiresAt: new Date((window + 2) * 3600000) });
  });
}
export async function publicCampaign(token: string) {
  if (!/^[\w-]{32}$/.test(token)) throw new HttpError(404, 'Offer not found');
  const tr = await col('tracking').doc(token).get();
  if (!tr.exists) throw new HttpError(404, 'Offer not found');
  const c = await getCampaign(tr.data()!.campaignId);
  if (['draft', 'expired'].includes(c.status))
    throw new HttpError(410, 'This offer is unavailable');
  const offer = await getOffer(c.offerId);
  if (Date.parse(offer.expiresAt) <= Date.now() || Date.parse(offer.startsAt) > Date.now())
    throw new HttpError(410, 'This offer is outside its validity period');
  return { campaign: c, offer };
}

export async function applyDelivery(status: {
  id: string;
  status: string;
  errors?: { code: number }[];
}) {
  const index = await col('messageIndex').doc(hash(status.id)).get();
  if (!index.exists) {
    await col('pendingStatuses')
      .doc(hash(status.id + status.status))
      .set({
        id: status.id,
        status: status.status,
        errors: status.errors || [],
        nextCheckAt: 0,
        at: now(),
        expiresAt: new Date(Date.now() + 7 * 86400000),
      });
    return;
  }
  const ref = db().doc(index.data()!.path);
  await db().runTransaction(async (tx) => {
    const m = await tx.get(ref);
    if (!m.exists) return;
    const current = m.data()!;
    if (current.metaId !== status.id) return;
    if (shouldUpdateDelivery(current.status, status.status))
      tx.update(ref, {
        status: status.status,
        ...(['delivered', 'read'].includes(status.status)
          ? { deliveredAt: current.deliveredAt || now() }
          : {}),
        ...(status.status === 'read' ? { readAt: now() } : {}),
        ...(status.status === 'failed'
          ? { error: 'Meta reported delivery failure', metaCode: status.errors?.[0]?.code || null }
          : {}),
      });
  });
}
async function reconcileStatuses() {
  const pending = await col('pendingStatuses').orderBy('nextCheckAt').limit(100).get();
  for (const d of pending.docs) {
    const s = d.data();
    if ((await col('messageIndex').doc(hash(s.id)).get()).exists) {
      await applyDelivery(s as { id: string; status: string; errors?: { code: number }[] });
      await d.ref.delete();
    } else {
      await d.ref.update({ nextCheckAt: Date.now() });
    }
  }
}
