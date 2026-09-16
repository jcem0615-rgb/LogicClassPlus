import { randomUUID } from 'node:crypto';
import { S3Client, PutObjectCommand, GetObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { ALLOWED_EXTENSIONS, env, isS3Configured } from '../env.js';
import { badRequest, payloadTooLarge } from '../lib/http-error.js';

export interface UploadTicket {
  storageKey: string;
  uploadUrl: string | null;
  method: 'PUT' | 'POST';
  expiresIn: number;
  driver: 's3' | 'local';
}

let client: S3Client | null = null;
function s3(): S3Client {
  if (!client) {
    client = new S3Client({
      region: env.S3_REGION,
      ...(env.S3_ENDPOINT ? { endpoint: env.S3_ENDPOINT, forcePathStyle: true } : {}),
      credentials: {
        accessKeyId: env.S3_ACCESS_KEY_ID!,
        secretAccessKey: env.S3_SECRET_ACCESS_KEY!,
      },
    });
  }
  return client;
}

/** Enforced before any storage key is issued — the client cannot bypass it. */
export function assertUploadAllowed(filename: string, bytes: number): string {
  const ext = (filename.split('.').pop() ?? '').toLowerCase();
  if (!ext || !(ALLOWED_EXTENSIONS as readonly string[]).includes(ext)) {
    throw badRequest(
      `.${ext || '?'} files are not allowed. Accepted: ${ALLOWED_EXTENSIONS.join(', ')}.`,
    );
  }
  if (bytes <= 0) throw badRequest('That file is empty.');
  if (bytes > env.UPLOAD_MAX_BYTES) {
    const mb = (env.UPLOAD_MAX_BYTES / 1048576).toFixed(0);
    throw payloadTooLarge(`That file is over the ${mb} MB limit. Compress it or split it up.`);
  }
  return ext;
}

export async function createUploadTicket(
  teacherId: string, folderId: string, filename: string, bytes: number, mimeType?: string,
): Promise<UploadTicket> {
  const ext = assertUploadAllowed(filename, bytes);
  const storageKey = `teachers/${teacherId}/folders/${folderId}/${randomUUID()}.${ext}`;

  if (!isS3Configured()) {
    // No bucket configured: the API accepts the bytes itself and writes them to disk.
    return { storageKey, uploadUrl: null, method: 'POST', expiresIn: 0, driver: 'local' };
  }

  const url = await getSignedUrl(
    s3(),
    new PutObjectCommand({
      Bucket: env.S3_BUCKET!, Key: storageKey, ContentLength: bytes,
      ...(mimeType ? { ContentType: mimeType } : {}),
    }),
    { expiresIn: 900 },
  );
  return { storageKey, uploadUrl: url, method: 'PUT', expiresIn: 900, driver: 's3' };
}

/** Short-lived read URL, scoped to one object. */
export async function createDownloadUrl(storageKey: string): Promise<string | null> {
  if (!isS3Configured()) return null;
  return getSignedUrl(s3(), new GetObjectCommand({ Bucket: env.S3_BUCKET!, Key: storageKey }), {
    expiresIn: 300,
  });
}
