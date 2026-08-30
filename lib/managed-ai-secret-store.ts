import { lstat, readFile } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";

export function createManagedAiSecretStore(managedDirectory: string) {
  if (!isAbsolute(managedDirectory) || resolve(managedDirectory) === "/") {
    throw new Error("AI_SECRET_DIRECTORY_INVALID");
  }
  return {
    async has(secretRef: string) {
      try {
        await this.read(secretRef);
        return true;
      } catch {
        return false;
      }
    },
    async read(secretRef: string) {
      const match = secretRef.match(/^managed:\/\/ai\/([a-f0-9]{64}\.secret)$/);
      if (!match) throw new Error("AI_SECRET_REF_INVALID");
      const directoryMetadata = await lstat(managedDirectory);
      if (!directoryMetadata.isDirectory() || directoryMetadata.isSymbolicLink()
        || (directoryMetadata.mode & 0o777) !== 0o700) {
        throw new Error("AI_SECRET_DIRECTORY_INVALID");
      }
      const path = join(managedDirectory,match[1]);
      const metadata = await lstat(path);
      if (!metadata.isFile() || metadata.isSymbolicLink() || (metadata.mode & 0o777) !== 0o600 || metadata.size > 4_096) {
        throw new Error("AI_SECRET_FILE_INVALID");
      }
      const value = await readFile(path,"utf8");
      if (!value || value.includes("\0")) throw new Error("AI_SECRET_FILE_INVALID");
      return value;
    },
  };
}
