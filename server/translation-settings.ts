import { constants, openSync, closeSync, fstatSync, readFileSync, writeFileSync, renameSync, unlinkSync, lstatSync, fsyncSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { z } from 'zod';
import { AppError } from './errors.ts';
import type { Store } from './store.ts';
import { TRANSLATION_MODEL, type TranslationSettingsStatus } from '../shared/translation.ts';

export const translationApiKey = z.string().trim().min(20).max(256).regex(/^[A-Za-z0-9_-]+$/, '请输入有效的 DeepSeek API Key');
const storedSettings = z.object({ version: z.literal(1), encryptedKey: z.string().startsWith('enc:').max(2048) }).strict();

// Separate from environment configuration, VM snapshots and backup exports.
// The renderer can save/clear a key but can never read the stored secret back.
export class TranslationSettings {
  private file: string;
  private store: Pick<Store, 'dataDir' | 'encrypt' | 'decrypt'>;
  revision = 0;
  constructor(store: Pick<Store, 'dataDir' | 'encrypt' | 'decrypt'>) {
    this.store = store;
    this.file = path.join(store.dataDir, 'translation-provider.json');
  }
  private read(): z.infer<typeof storedSettings> | null {
    let fd: number | undefined;
    try {
      const directory = lstatSync(this.store.dataDir);
      if (!directory.isDirectory() || directory.uid !== process.getuid?.() || directory.mode & 0o077) throw Error();
      try { fd = openSync(this.file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK); }
      catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error; }
      const st = fstatSync(fd);
      if (!st.isFile() || st.uid !== process.getuid?.() || st.nlink !== 1 || st.mode & 0o077 || st.size > 4096) throw Error();
      return storedSettings.parse(JSON.parse(readFileSync(fd, 'utf8')));
    } catch { throw new AppError('翻译密钥文件无法安全读取，请检查本机配置。', 409, 'TRANSLATION_SETTINGS_INVALID'); }
    finally { if (fd !== undefined) closeSync(fd); }
  }
  status(): TranslationSettingsStatus {
    const configured = this.read() !== null;
    return { configured, provider: 'DeepSeek', model: TRANSLATION_MODEL };
  }
  credential() {
    const settings = this.read();
    if (!settings) throw new AppError('请先在翻译设置中填写 DeepSeek API Key。', 409, 'TRANSLATION_KEY_REQUIRED');
    try { return { apiKey: translationApiKey.parse(this.store.decrypt(settings.encryptedKey)), revision: this.revision }; }
    catch { throw new AppError('翻译密钥无法解密，请重新填写。', 409, 'TRANSLATION_KEY_INVALID'); }
  }
  save(value: string): TranslationSettingsStatus {
    const apiKey = translationApiKey.parse(value);
    this.read(); // Do not overwrite an unsafe link or an unrecognized file.
    const temporary = path.join(this.store.dataDir, `.translation-${randomUUID()}.tmp`);
    try {
      const fd = openSync(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
      try { writeFileSync(fd, JSON.stringify({ version: 1, encryptedKey: this.store.encrypt(apiKey) })); fsyncSync(fd); }
      finally { closeSync(fd); }
      renameSync(temporary, this.file);
      this.revision++;
      return this.status();
    } catch { throw new AppError('翻译密钥未能保存，请重试。', 409, 'TRANSLATION_SETTINGS_SAVE_FAILED'); }
    finally { try { unlinkSync(temporary); } catch { /* No temporary secret remains after success. */ } }
  }
  clear(): TranslationSettingsStatus {
    if (this.read()) unlinkSync(this.file);
    this.revision++;
    return this.status();
  }
}
