import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
  createHash,
} from "crypto";
import { Keypair } from "@solana/web3.js";
import nacl from "tweetnacl";

const STATIC_MESSAGE = Buffer.from("Permagit Repo Encryption v1");

export function deriveAesKeyFromKeypair(keypair: Keypair): Buffer {
  // Sign a static message with secret key using Ed25519 (detached), then hash to 32-byte key
  const sig = nacl.sign.detached(
    Uint8Array.from(STATIC_MESSAGE),
    keypair.secretKey
  );
  const key = createHash("sha256").update(Buffer.from(sig)).digest(); // 32 bytes
  return key;
}

export function deriveAesKeyFromSignature(signature: Uint8Array): Buffer {
  // Derive 32-byte AES key from detached signature bytes
  return createHash("sha256").update(Buffer.from(signature)).digest();
}

export function deriveAesKeyFromSignatureB64(signatureB64: string): Buffer {
  const sig = Buffer.from(signatureB64, "base64");
  return createHash("sha256").update(sig).digest();
}

export function encryptAesGcm(
  plaintext: Buffer,
  key: Buffer
): { iv: Buffer; ciphertext: Buffer; authTag: Buffer } {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return { iv, ciphertext, authTag };
}

export function decryptAesGcm(
  enc: { iv: Buffer; ciphertext: Buffer; authTag: Buffer },
  key: Buffer
): Buffer {
  const decipher = createDecipheriv("aes-256-gcm", key, enc.iv);
  decipher.setAuthTag(enc.authTag);
  const plain = Buffer.concat([
    decipher.update(enc.ciphertext),
    decipher.final(),
  ]);
  return plain;
}
