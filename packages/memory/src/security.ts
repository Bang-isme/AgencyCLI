import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

export class SecurityHardening {
  private static ALGORITHM = "aes-256-gcm";

  /**
   * Encrypts plain string value using AES-256-GCM
   */
  public static encrypt(val: string, secretKeyHex: string): { ciphertext: string; iv: string; tag: string } {
    if (!secretKeyHex || secretKeyHex.length !== 64) {
      throw new Error("Invalid encryption secret key. Key must be a 64-char Hex string.");
    }

    const key = Buffer.from(secretKeyHex, "hex");
    const iv = randomBytes(12);
    const cipher = createCipheriv(this.ALGORITHM, key, iv);

    let ciphertext = cipher.update(val, "utf8", "hex");
    ciphertext += cipher.final("hex");

    const tag = (cipher as any).getAuthTag().toString("hex");

    return {
      ciphertext,
      iv: iv.toString("hex"),
      tag,
    };
  }

  /**
   * Decrypts ciphertext value using AES-256-GCM
   */
  public static decrypt(ciphertext: string, ivHex: string, tagHex: string, secretKeyHex: string): string {
    if (!secretKeyHex || secretKeyHex.length !== 64) {
      throw new Error("Invalid decryption secret key. Key must be a 64-char Hex string.");
    }

    const key = Buffer.from(secretKeyHex, "hex");
    const iv = Buffer.from(ivHex, "hex");
    const tag = Buffer.from(tagHex, "hex");
    const decipher = createDecipheriv(this.ALGORITHM, key, iv);

    (decipher as any).setAuthTag(tag);

    let plaintext = decipher.update(ciphertext, "hex", "utf8");
    plaintext += decipher.final("utf8");

    return plaintext;
  }
}
