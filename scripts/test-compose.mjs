import { spawnSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { createRequire } from "node:module";
import { createServer } from "node:net";

const requireStorageDependency = createRequire(
  new URL("../packages/storage/package.json", import.meta.url),
);
const { PutBucketPolicyCommand, S3Client } = requireStorageDependency("@aws-sdk/client-s3");

const composeFile = "deploy/docker-compose.yml";
const requiredServices = [
  "api",
  "app-migrate",
  "caddy",
  "graphile-migrate",
  "jobs",
  "minio",
  "minio-init",
  "postgres",
];
const databaseName = "figlab_smoke";
const databaseUser = "figlab_smoke";
const databasePassword = randomBytes(24).toString("hex");
const baseEnvironment = {
  ...process.env,
  DATABASE_URL: `postgres://${databaseUser}:${databasePassword}@postgres:5432/${databaseName}`,
  POSTGRES_DB: databaseName,
  POSTGRES_USER: databaseUser,
  POSTGRES_PASSWORD: databasePassword,
  OBJECT_STORE_INTERNAL_ENDPOINT: "http://minio:9000",
};

const rendered = run(["compose", "-f", composeFile, "config", "--format", "json"], {
  capture: true,
  environment: baseEnvironment,
});
const configuration = JSON.parse(rendered.stdout);
for (const service of requiredServices) {
  if (!configuration.services?.[service]) throw new Error(`Compose service ${service} is missing`);
}
if (process.argv.includes("--config-only")) {
  console.log("FigLab Compose configuration includes every required service.");
  process.exit(0);
}

const httpPort = await availablePort();
const minioPort = await availablePort();
const consolePort = await availablePort();
const projectName = `figlab-smoke-${process.pid}`;
const publicOrigin = `http://127.0.0.1:${httpPort}`;
const environment = {
  ...baseEnvironment,
  FIGLAB_BIND_ADDRESS: "127.0.0.1",
  FIGLAB_HTTP_PORT: String(httpPort),
  FIGLAB_MINIO_PORT: String(minioPort),
  FIGLAB_MINIO_CONSOLE_PORT: String(consolePort),
  PUBLIC_APP_URL: publicOrigin,
  OBJECT_STORE_PUBLIC_ENDPOINT: `http://127.0.0.1:${minioPort}`,
};

try {
  run(["compose", "-p", projectName, "-f", composeFile, "up", "--build", "-d", "--wait"], {
    environment,
    timeoutMs: 1_200_000,
  });
  await expectResponse(`${publicOrigin}/health`, 200);
  const homepage = await expectResponse(publicOrigin, 200);
  if (!homepage.includes("FigLab")) throw new Error("Caddy did not serve the FigLab web bundle");

  const project = await requestJson(`${publicOrigin}/v1/projects`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name: "Compose smoke" }),
  });
  const sourceRender = renderSharedPng({ mode: "source" });
  const png = Uint8Array.from(Buffer.from(sourceRender.base64, "base64"));
  const checksumSha256 = sourceRender.checksumSha256;
  const reservation = await requestJson(`${publicOrigin}/v1/projects/${project.id}/uploads`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      filename: "smoke.png",
      contentType: "image/png",
      contentLength: png.byteLength,
      checksumSha256,
    }),
  });
  const signedUpload = new URL(reservation.upload.url);
  const publicMinioOrigin = `http://127.0.0.1:${minioPort}`;
  if (signedUpload.origin !== publicMinioOrigin) {
    throw new Error(`Presigned PUT did not resolve directly to public MinIO: ${signedUpload}`);
  }
  const cors = await fetch(reservation.upload.url, {
    method: "OPTIONS",
    headers: {
      origin: publicOrigin,
      "access-control-request-method": "PUT",
      "access-control-request-headers": Object.keys(reservation.upload.headers)
        .filter((header) => header.toLowerCase() !== "content-length")
        .join(","),
    },
  });
  const allowedMethods = cors.headers.get("access-control-allow-methods") ?? "";
  const allowedHeaders = cors.headers.get("access-control-allow-headers") ?? "";
  if (
    !cors.ok ||
    cors.headers.get("access-control-allow-origin") !== publicOrigin ||
    !allowedMethods.includes("PUT") ||
    (!allowedHeaders.includes("*") && !allowedHeaders.toLowerCase().includes("if-none-match"))
  ) {
    throw new Error("MinIO CORS preflight did not authorize the signed browser PUT");
  }
  const uploaded = await fetch(reservation.upload.url, {
    method: reservation.upload.method,
    headers: reservation.upload.headers,
    body: png,
  });
  if (!uploaded.ok) throw new Error(`Direct MinIO upload failed: ${uploaded.status}`);
  const overwrite = await fetch(reservation.upload.url, {
    method: reservation.upload.method,
    headers: reservation.upload.headers,
    body: png,
  });
  if (overwrite.ok) throw new Error("MinIO accepted an overwrite of an immutable storage key");
  await requestJson(`${publicOrigin}/v1/uploads/${reservation.uploadId}/complete`, {
    method: "POST",
  });

  const asset = await waitForReady(`${publicOrigin}/v1/assets/${reservation.assetId}`);
  if (asset.widthPx !== 4 || asset.heightPx !== 2) {
    throw new Error(`Verified dimensions were not 4x2: ${JSON.stringify(asset)}`);
  }
  const download = await requestJson(
    `${publicOrigin}/v1/assets/${reservation.assetId}/download-url`,
    { method: "POST" },
  );
  const signedDownload = new URL(download.url);
  if (signedDownload.origin !== publicMinioOrigin) {
    throw new Error(`Presigned GET did not resolve directly to public MinIO: ${signedDownload}`);
  }
  const downloadCors = await fetch(download.url, {
    method: "OPTIONS",
    headers: { origin: publicOrigin, "access-control-request-method": "GET" },
  });
  if (
    !downloadCors.ok ||
    downloadCors.headers.get("access-control-allow-origin") !== publicOrigin
  ) {
    throw new Error("MinIO CORS preflight did not authorize the signed browser GET");
  }
  const downloadResponse = await fetch(download.url, { headers: { origin: publicOrigin } });
  if (downloadResponse.headers.get("access-control-allow-origin") !== publicOrigin) {
    throw new Error("Signed MinIO download did not include the browser CORS origin");
  }
  const downloaded = new Uint8Array(await downloadResponse.arrayBuffer());
  if (createHash("sha256").update(downloaded).digest("hex") !== checksumSha256) {
    throw new Error("Downloaded immutable original did not match the uploaded checksum");
  }
  const minioEnvironment = configuration.services.minio.environment;
  const bucket = configuration.services["minio-init"].environment.OBJECT_STORE_BUCKET;
  const adminStore = new S3Client({
    region: configuration.services["minio-init"].environment.OBJECT_STORE_REGION,
    endpoint: publicMinioOrigin,
    credentials: {
      accessKeyId: minioEnvironment.MINIO_ROOT_USER,
      secretAccessKey: minioEnvironment.MINIO_ROOT_PASSWORD,
    },
    forcePathStyle: true,
    requestChecksumCalculation: "WHEN_REQUIRED",
  });
  await adminStore.send(
    new PutBucketPolicyCommand({
      Bucket: bucket,
      Policy: JSON.stringify({
        Version: "2012-10-17",
        Statement: [
          {
            Sid: "SmokePublicRead",
            Effect: "Allow",
            Principal: "*",
            Action: "s3:GetObject",
            Resource: `arn:aws:s3:::${bucket}/*`,
          },
        ],
      }),
    }),
  );
  adminStore.destroy();
  const unsignedDownload = new URL(download.url);
  unsignedDownload.search = "";
  if (!(await fetch(unsignedDownload)).ok) {
    throw new Error("Could not reproduce a public bucket policy before the privacy check");
  }
  run(["compose", "-p", projectName, "-f", composeFile, "run", "--rm", "--no-deps", "minio-init"], {
    environment,
    timeoutMs: 30_000,
  });
  if ((await fetch(unsignedDownload)).status !== 403) {
    throw new Error("MinIO initialization did not remove the bucket's anonymous read policy");
  }
  const loaded = await requestJson(`${publicOrigin}/v1/projects/${project.id}/document`);
  const imageViewId = "00000000-0000-4000-8000-000000000010";
  const siblingViewId = "00000000-0000-4000-8000-000000000011";
  const document = {
    ...loaded.document,
    objects: [
      {
        id: imageViewId,
        type: "image-view",
        artboardId: loaded.document.artboards[0].id,
        transform: { xPt: 36, yPt: 48, widthPt: 144, heightPt: 144, rotationDeg: 0 },
        zIndex: 0,
        locked: false,
        hidden: false,
        view: {
          sourceAssetId: reservation.assetId,
          viewport: { x: 0.25, y: 0, width: 0.5, height: 1 },
          display: { brightness: 0.1, contrast: 1.2, gamma: 0.9, invert: false },
        },
      },
      {
        id: siblingViewId,
        type: "image-view",
        artboardId: loaded.document.artboards[0].id,
        transform: { xPt: 216, yPt: 48, widthPt: 144, heightPt: 144, rotationDeg: 0 },
        zIndex: 1,
        locked: false,
        hidden: false,
        view: {
          sourceAssetId: reservation.assetId,
          viewport: { x: 0.5, y: 0, width: 0.5, height: 1 },
          display: { brightness: 0, contrast: 1, gamma: 1, invert: true },
        },
      },
    ],
  };
  const saved = await requestJson(`${publicOrigin}/v1/projects/${project.id}/document`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ baseRevision: loaded.revision, document }),
  });
  const reopened = await requestJson(`${publicOrigin}/v1/projects/${project.id}/document`);
  if (
    reopened.revision !== saved.revision ||
    reopened.document.objects[0]?.id !== imageViewId ||
    reopened.document.objects[1]?.id !== siblingViewId
  ) {
    throw new Error("Versioned crop document did not survive save/reload");
  }
  const stale = await fetch(`${publicOrigin}/v1/projects/${project.id}/document`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ baseRevision: loaded.revision, document }),
  });
  if (stale.status !== 409) throw new Error(`Stale save returned ${stale.status} instead of 409`);
  const exportRender = renderSharedPng({
    mode: "export",
    document: reopened.document,
    widthPx: 612,
    heightPx: 792,
  });
  const exportBytes = Buffer.from(exportRender.base64, "base64");
  if (exportBytes.readUInt32BE(16) !== 612 || exportBytes.readUInt32BE(20) !== 792) {
    throw new Error("Shared CPU export did not produce the requested 612x792 PNG");
  }
  await requestJson(`${publicOrigin}/v1/projects/${project.id}/exports`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      format: "png",
      revision: reopened.revision,
      widthPx: 612,
      heightPx: 792,
      checksumSha256: exportRender.checksumSha256,
    }),
  });
  console.log("FigLab clean-volume Compose smoke passed with direct MinIO upload/download.");
} finally {
  run(["compose", "-p", projectName, "-f", composeFile, "down", "-v", "--remove-orphans"], {
    environment,
    allowFailure: true,
    timeoutMs: 120_000,
  });
}

async function waitForReady(url) {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    const asset = await requestJson(url);
    if (asset.status === "ready") return asset;
    if (asset.status === "rejected") throw new Error(`Asset rejected: ${asset.rejectionReason}`);
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error("Timed out waiting for the jobs service to verify the upload");
}

async function requestJson(url, init) {
  const response = await fetch(url, init);
  const body = await response.text();
  if (!response.ok) throw new Error(`${init?.method ?? "GET"} ${url}: ${response.status} ${body}`);
  return body ? JSON.parse(body) : undefined;
}

async function expectResponse(url, status) {
  const response = await fetch(url);
  const body = await response.text();
  if (response.status !== status) throw new Error(`GET ${url}: ${response.status} ${body}`);
  return body;
}

function run(arguments_, options = {}) {
  const result = spawnSync("docker", arguments_, {
    cwd: process.cwd(),
    encoding: "utf8",
    env: options.environment ?? process.env,
    stdio: options.capture ? "pipe" : "inherit",
    timeout: options.timeoutMs ?? 30_000,
  });
  if (result.status !== 0 && !options.allowFailure) {
    throw new Error(
      result.stderr || result.error?.message || `docker ${arguments_.join(" ")} failed`,
    );
  }
  return result;
}

function renderSharedPng(input) {
  const result = spawnSync("apps/jobs/node_modules/.bin/tsx", ["scripts/compose-export.ts"], {
    cwd: process.cwd(),
    encoding: "utf8",
    input: JSON.stringify(input),
    timeout: 30_000,
  });
  if (result.status !== 0) {
    throw new Error(result.stderr || result.error?.message || "Shared CPU PNG export failed");
  }
  return JSON.parse(result.stdout);
}

async function availablePort() {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (typeof address === "string" || address === null) {
        server.close();
        reject(new Error("Could not allocate a local TCP port"));
        return;
      }
      server.close((error) => (error ? reject(error) : resolve(address.port)));
    });
  });
}
