import { committedRestoreStatus, restoreOfflineBackup } from "../../lib/proofcanvas/backup.server";
import { proofCanvasDataDirectory } from "../../lib/proofcanvas/database.server";

function main() {
  const [source, ...extra] = process.argv.slice(2);
  if (!source || extra.length) throw new Error("Usage: npm run db:restore -- /absolute/path/to/backup.sqlite3");
  const dataDirectory = proofCanvasDataDirectory();
  const receipt = restoreOfflineBackup(source, { dataDirectory, privateSnapshotRoot: dataDirectory });
  process.stdout.write(`${JSON.stringify(receipt)}\n`);
}

try {
  main();
} catch (error) {
  const committed = committedRestoreStatus(error);
  process.stderr.write(committed
    ? `${JSON.stringify(committed)}\n`
    : `ProofCanvas offline restore failed: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
}
