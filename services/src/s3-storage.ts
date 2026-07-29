import {
  DeleteObjectCommand,
  GetObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client
} from "@aws-sdk/client-s3";

import {
  normalizeObjectKey,
  type ObjectStorage,
  type ObjectSummary,
  type PutObjectInput,
  type StoredObject
} from "./object-storage.js";

export interface S3ObjectStorageOptions {
  readonly accessKeyId?: string;
  readonly bucket: string;
  readonly endpoint?: string;
  readonly forcePathStyle?: boolean;
  readonly region: string;
  readonly secretAccessKey?: string;
}

export class S3ObjectStorage implements ObjectStorage {
  readonly #client: S3Client;
  public constructor(private readonly options: S3ObjectStorageOptions) {
    this.#client = new S3Client({
      ...(options.accessKeyId === undefined || options.secretAccessKey === undefined
        ? {}
        : {
            credentials: {
              accessKeyId: options.accessKeyId,
              secretAccessKey: options.secretAccessKey
            }
          }),
      ...(options.endpoint === undefined ? {} : { endpoint: options.endpoint }),
      forcePathStyle: options.forcePathStyle ?? false,
      region: options.region
    });
  }

  public async put(input: PutObjectInput): Promise<void> {
    await this.#client.send(
      new PutObjectCommand({
        Body: input.body,
        Bucket: this.options.bucket,
        ContentType: input.contentType,
        Key: normalizeObjectKey(input.key),
        Metadata: input.metadata
      })
    );
  }

  public async get(key: string): Promise<StoredObject | undefined> {
    try {
      const result = await this.#client.send(
        new GetObjectCommand({ Bucket: this.options.bucket, Key: normalizeObjectKey(key) })
      );
      if (result.Body === undefined) throw new Error("S3 returned an object without a body.");
      return {
        body: await result.Body.transformToByteArray(),
        ...(result.ContentType === undefined ? {} : { contentType: result.ContentType }),
        ...(result.ETag === undefined ? {} : { etag: result.ETag }),
        metadata: result.Metadata ?? {}
      };
    } catch (error: unknown) {
      const name = error instanceof Error ? error.name : "";
      if (name === "NoSuchKey" || name === "NotFound") return undefined;
      throw error;
    }
  }

  public async delete(key: string): Promise<void> {
    await this.#client.send(
      new DeleteObjectCommand({ Bucket: this.options.bucket, Key: normalizeObjectKey(key) })
    );
  }

  public async list(prefix = ""): Promise<readonly ObjectSummary[]> {
    const output: ObjectSummary[] = [];
    let token: string | undefined;
    do {
      const result = await this.#client.send(
        new ListObjectsV2Command({
          Bucket: this.options.bucket,
          ContinuationToken: token,
          Prefix: prefix === "" ? undefined : normalizeObjectKey(prefix)
        })
      );
      for (const item of result.Contents ?? []) {
        if (item.Key !== undefined) {
          output.push({
            key: item.Key,
            ...(item.LastModified === undefined ? {} : { lastModified: item.LastModified }),
            size: item.Size ?? 0
          });
        }
      }
      token = result.IsTruncated ? result.NextContinuationToken : undefined;
    } while (token !== undefined);
    return output;
  }
}
