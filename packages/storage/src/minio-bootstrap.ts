import { CreateBucketCommand, HeadBucketCommand, S3Client } from "@aws-sdk/client-s3";

const required = (name: string): string => {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
};

const bucket = required("OBJECT_STORE_BUCKET");
const client = new S3Client({
  region: process.env.OBJECT_STORE_REGION ?? "us-east-1",
  endpoint: required("OBJECT_STORE_INTERNAL_ENDPOINT"),
  credentials: {
    accessKeyId: required("OBJECT_STORE_ACCESS_KEY"),
    secretAccessKey: required("OBJECT_STORE_SECRET_KEY"),
  },
  forcePathStyle: true,
  requestChecksumCalculation: "WHEN_REQUIRED",
});

try {
  await client.send(new HeadBucketCommand({ Bucket: bucket }));
} catch (error) {
  const status = (error as { $metadata?: { httpStatusCode?: number } }).$metadata?.httpStatusCode;
  if (status !== 404) throw error;
  await client.send(new CreateBucketCommand({ Bucket: bucket }));
}
client.destroy();
