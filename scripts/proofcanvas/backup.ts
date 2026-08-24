import { createOnlineBackup } from "../../lib/proofcanvas/backup.server";
import { openProofCanvasDatabase, proofCanvasDataDirectory, proofCanvasDatabasePath } from "../../lib/proofcanvas/database.server";

async function main() {
  if (process.argv.length !== 2) throw new Error("Usage: npm run db:backup");
  const dataDirectory = proofCanvasDataDirectory();
  // This readonly connection deliberately does not acquire the supported
  // writer/maintenance lease. SQLite's online backup API is safe while WAL
  // writes continue, and a private copy is fully validated before publication.
  const database = openProofCanvasDatabase({ path: proofCanvasDatabasePath(), readonly: true, migrate: false });
  try {
    const receipt = await createOnlineBackup({ database, dataDirectory });
    process.stdout.write(`${JSON.stringify(receipt)}\n`);
  } finally {
    database.close();
  }
}

main().catch((error) => {
  process.stderr.write(`ProofCanvas online backup failed: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
