import {
  PROOFCANVAS_PROJECT_PACKAGE_EXTENSION,
  PROOFCANVAS_PROJECT_PACKAGE_FORMAT,
  PROOFCANVAS_PROJECT_PACKAGE_LIMITS,
  PROOFCANVAS_PROJECT_PACKAGE_MEDIA_TYPE,
  PROOFCANVAS_PROJECT_PACKAGE_VERSION,
  ProjectPackageError,
  ProjectPackageManifestSchema,
  canonicalProjectPackageManifestJson,
  projectPackageAssetPath,
} from "../projectPackage";
import { PROJECT_SCHEMA_VERSION } from "../schema";

const manifest = {
  assets: [
    {
      id: "asset-diagram",
      path: `assets/${"a".repeat(64)}.png`,
    },
  ],
  format: PROOFCANVAS_PROJECT_PACKAGE_FORMAT,
  packageVersion: PROOFCANVAS_PROJECT_PACKAGE_VERSION,
  project: {
    bytes: 123,
    path: "project.json" as const,
    schemaVersion: PROJECT_SCHEMA_VERSION,
    sha256: "b".repeat(64),
  },
  source: {
    projectId: "project-example",
    revision: 7,
  },
};

test("publishes the package identity and bounded in-memory contract", () => {
  expect(PROOFCANVAS_PROJECT_PACKAGE_MEDIA_TYPE).toBe("application/vnd.proofcanvas.package+zip");
  expect(PROOFCANVAS_PROJECT_PACKAGE_EXTENSION).toBe(".proofcanvas");
  expect(PROOFCANVAS_PROJECT_PACKAGE_LIMITS).toEqual({
    maxArchiveBytes: 132 * 1024 * 1024,
    maxEntries: 259,
    maxCentralDirectoryBytes: 128 * 1024,
    maxEntryPathBytes: 96,
    maxManifestBytes: 256 * 1024,
    maxProjectBytes: 2 * 1024 * 1024,
    maxAssetBytes: 64 * 1024 * 1024,
    maxAssetAggregateBytes: 128 * 1024 * 1024,
    maxDecodedImageAggregateBytes: 512 * 1024 * 1024,
  });
});

test("serializes strict recursively sorted manifest JSON with one LF", () => {
  expect(canonicalProjectPackageManifestJson(manifest)).toBe(`{
  "assets": [
    {
      "id": "asset-diagram",
      "path": "assets/${"a".repeat(64)}.png"
    }
  ],
  "format": "proofcanvas-package",
  "packageVersion": 1,
  "project": {
    "bytes": 123,
    "path": "project.json",
    "schemaVersion": 4,
    "sha256": "${"b".repeat(64)}"
  },
  "source": {
    "projectId": "project-example",
    "revision": 7
  }
}
`);

  expect(ProjectPackageManifestSchema.safeParse({
    ...manifest,
    source: { ...manifest.source, unexpected: true },
  }).success).toBe(false);
  expect(ProjectPackageManifestSchema.safeParse({
    ...manifest,
    assets: [manifest.assets[0], manifest.assets[0]],
  }).success).toBe(false);
});

test("derives canonical content paths solely from hash and MIME type", () => {
  const sha256 = "c".repeat(64);
  expect(projectPackageAssetPath({ mimeType: "image/jpeg", sha256 })).toBe(`assets/${sha256}.jpg`);
  expect(projectPackageAssetPath({ mimeType: "audio/mp4", sha256 })).toBe(`assets/${sha256}.m4a`);
  expect(() => projectPackageAssetPath({ mimeType: "image/png", sha256: "C".repeat(64) }))
    .toThrow(expect.objectContaining<ProjectPackageError>({ code: "invalid_asset_metadata" }));
});
