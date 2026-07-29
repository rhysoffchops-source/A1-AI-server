import { LocalObjectStorage, type ObjectStorage } from "./object-storage.js";
import { S3ObjectStorage } from "./s3-storage.js";

export type StorageConfiguration =
  | {
      readonly id: string;
      readonly rootPath: string;
      readonly type: "local";
    }
  | {
      readonly accessKeySecret?: string | undefined;
      readonly bucket: string;
      readonly endpoint?: string | undefined;
      readonly forcePathStyle: boolean;
      readonly id: string;
      readonly region: string;
      readonly secretKeySecret?: string | undefined;
      readonly type: "s3";
    };

export async function createObjectStorage(
  configuration: StorageConfiguration,
  resolveSecret: (handle: string) => Promise<string | undefined>
): Promise<ObjectStorage> {
  if (configuration.type === "local") return new LocalObjectStorage(configuration.rootPath);
  const accessKeyId =
    configuration.accessKeySecret === undefined
      ? undefined
      : await resolveSecret(configuration.accessKeySecret);
  const secretAccessKey =
    configuration.secretKeySecret === undefined
      ? undefined
      : await resolveSecret(configuration.secretKeySecret);
  if ((accessKeyId === undefined) !== (secretAccessKey === undefined)) {
    throw new Error(`S3 provider "${configuration.id}" requires both access and secret keys.`);
  }
  if (configuration.accessKeySecret !== undefined && accessKeyId === undefined) {
    throw new Error(`S3 provider "${configuration.id}" access-key secret is not configured.`);
  }
  return new S3ObjectStorage({
    ...(accessKeyId === undefined ? {} : { accessKeyId }),
    bucket: configuration.bucket,
    ...(configuration.endpoint === undefined ? {} : { endpoint: configuration.endpoint }),
    forcePathStyle: configuration.forcePathStyle,
    region: configuration.region,
    ...(secretAccessKey === undefined ? {} : { secretAccessKey })
  });
}
