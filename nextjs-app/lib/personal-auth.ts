import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { ChatError, ChatStore, chatHash } from './account-chat-api';
export function sealPersonal(value: string, uid: string, slot: string, secret: string) {
  if (!/^[a-f0-9]{64}$/i.test(secret))
    throw new ChatError(503, 'Secure WhatsApp session storage is unavailable.');
  const iv = randomBytes(12),
    cipher = createCipheriv('aes-256-gcm', Buffer.from(secret, 'hex'), iv);
  cipher.setAAD(Buffer.from(`bpl-personal:${uid}:${slot}:1`));
  const bytes = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
  return {
    version: 1,
    iv: iv.toString('base64'),
    tag: cipher.getAuthTag().toString('base64'),
    ciphertext: bytes.toString('base64'),
  };
}
export function openPersonal(
  value: Record<string, any>,
  uid: string,
  slot: string,
  secret: string,
) {
  if (value.version !== 1) throw new Error('Unsupported personal session');
  const decipher = createDecipheriv(
    'aes-256-gcm',
    Buffer.from(secret, 'hex'),
    Buffer.from(value.iv, 'base64'),
  );
  decipher.setAAD(Buffer.from(`bpl-personal:${uid}:${slot}:1`));
  decipher.setAuthTag(Buffer.from(value.tag, 'base64'));
  return Buffer.concat([
    decipher.update(Buffer.from(value.ciphertext, 'base64')),
    decipher.final(),
  ]).toString('utf8');
}
export class PersonalAuthStore {
  constructor(
    readonly store: ChatStore,
    readonly serialize: (v: unknown) => string,
    readonly parse: (v: string) => any,
    readonly generation = '',
  ) {}
  async path(slot: string) {
    return `personalAuth/${await chatHash(`${this.generation}:${slot}`)}`;
  }
  async read(slot: string) {
    const doc = await this.store.read(await this.path(slot));
    return doc
      ? this.parse(
          openPersonal(
            doc.data,
            this.store.uid,
            `${this.generation}:${slot}`,
            this.store.env.encryptionKey,
          ),
        )
      : null;
  }
  async write(values: Record<string, unknown>) {
    const writes = [];
    for (const [slot, value] of Object.entries(values)) {
      const path = await this.path(slot);
      writes.push(
        value === null
          ? this.store.remove(path)
          : this.store.write(
              path,
              sealPersonal(
                this.serialize(value),
                this.store.uid,
                `${this.generation}:${slot}`,
                this.store.env.encryptionKey,
              ),
              undefined,
            ),
      );
    }
    for (let at = 0; at < writes.length; at += 400)
      await this.store.commit(writes.slice(at, at + 400));
  }
}
