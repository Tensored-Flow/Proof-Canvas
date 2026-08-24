import { stdin, stdout } from "node:process";
import { hashOwnerPassword, MAX_PASSWORD_BYTES } from "../../lib/proofcanvas/credentials";

async function readPassword(): Promise<string> {
  if (stdin.isTTY) {
    throw new Error("Refusing to read an echoed password. Pipe one password through standard input.");
  }
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of stdin) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    bytes += buffer.length;
    if (bytes > MAX_PASSWORD_BYTES + 2) throw new Error(`Password input exceeds ${MAX_PASSWORD_BYTES} UTF-8 bytes`);
    chunks.push(buffer);
  }
  const raw = Buffer.concat(chunks).toString("utf8");
  const password = raw.endsWith("\r\n") ? raw.slice(0, -2) : raw.endsWith("\n") ? raw.slice(0, -1) : raw;
  if (password.includes("\n") || password.includes("\r")) throw new Error("Password input must contain exactly one line");
  return password;
}

async function main() {
  const password = await readPassword();
  stdout.write(`${await hashOwnerPassword(password)}\n`);
}

main().catch((error) => {
  process.stderr.write(`ProofCanvas password hashing failed: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
