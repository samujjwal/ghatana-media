package com.ghatana.tts.security;

import javax.crypto.Cipher;
import javax.crypto.KeyGenerator;
import javax.crypto.SecretKey;
import javax.crypto.spec.GCMParameterSpec;
import javax.crypto.spec.SecretKeySpec;
import java.nio.ByteBuffer;
import java.nio.ByteOrder;
import java.security.NoSuchAlgorithmException;
import java.security.SecureRandom;
import java.util.Base64;
import java.util.Objects;

/**
 * Encrypts and decrypts voice embeddings and audio metadata at rest using AES-256-GCM.
 *
 * <h2>Design</h2>
 * <ul>
 *   <li>Algorithm: AES-256-GCM (authenticated encryption with associated data — AEAD).</li>
 *   <li>IV: 12 random bytes generated per encryption operation (NIST SP 800-38D §8.2).</li>
 *   <li>Tag length: 128 bits (GCM default; provides both confidentiality and integrity).</li>
 *   <li>Wire format: {@code [12-byte IV][ciphertext+16-byte GCM tag]} — all concatenated,
 *       Base64-encoded for storage in VARCHAR/TEXT columns.</li>
 *   <li>Key management: callers supply the {@link SecretKey}; this service does <em>not</em>
 *       manage key lifecycle. Integrate with a KMS (e.g., AWS KMS, HashiCorp Vault) to
 *       provision and rotate the key outside of application code.</li>
 * </ul>
 *
 * <h2>Privacy threat model</h2>
 * <p>Voice embeddings are biometric data. Even if the backing database is compromised, an
 * attacker without the AES key cannot reconstruct a speaker's voice print. The GCM
 * authentication tag additionally prevents silent bit-flip attacks on stored embeddings.</p>
 *
 * <h2>Key rotation</h2>
 * <p>To rotate keys: (1) provision a new key in the KMS; (2) re-encrypt stored ciphertext by
 * decrypting with the old key and encrypting with the new key; (3) retire the old key. This
 * service handles step 2 by accepting both old and new keys as caller arguments.</p>
 *
 * <h2>Thread safety</h2>
 * <p>This service is stateless and thread-safe. Each method call creates a fresh {@link Cipher}
 * instance — {@link Cipher} objects are not thread-safe and must not be shared across threads.
 * </p>
 *
 * @doc.type class
 * @doc.purpose Encrypt voice embeddings and audio metadata at rest using AES-256-GCM
 * @doc.layer product
 * @doc.pattern Service
 */
public final class EmbeddingEncryptionService {

    private static final String ALGORITHM = "AES/GCM/NoPadding";
    private static final int GCM_IV_LENGTH_BYTES = 12;
    private static final int GCM_TAG_LENGTH_BITS = 128;
    private static final int FLOATS_PER_BYTE = 4; // IEEE 754 float = 4 bytes

    private final SecureRandom secureRandom;

    /**
     * Constructs an {@code EmbeddingEncryptionService} with a platform-default
     * cryptographically strong random source.
     */
    public EmbeddingEncryptionService() {
        this.secureRandom = new SecureRandom();
    }

    // Visible for testing
    EmbeddingEncryptionService(SecureRandom secureRandom) {
        this.secureRandom = Objects.requireNonNull(secureRandom, "secureRandom cannot be null");
    }

    /**
     * Generates a new random AES-256 key suitable for embedding encryption.
     * The returned key should be persisted only in a KMS or hardware security module —
     * never in application configuration or source code.
     *
     * @return a newly generated AES-256 {@link SecretKey}
     * @throws IllegalStateException if AES is not available in this JVM
     */
    public static SecretKey generateKey() {
        try {
            KeyGenerator kg = KeyGenerator.getInstance("AES");
            kg.init(256);
            return kg.generateKey();
        } catch (NoSuchAlgorithmException e) {
            throw new IllegalStateException("AES not available", e);
        }
    }

    /**
     * Creates a {@link SecretKey} from a raw 32-byte (256-bit) key material byte array.
     * Useful when loading a key previously exported from a KMS.
     *
     * @param keyBytes 32-byte raw key material
     * @return AES {@link SecretKey}
     * @throws IllegalArgumentException if {@code keyBytes} is not exactly 32 bytes
     */
    public static SecretKey keyFromBytes(byte[] keyBytes) {
        Objects.requireNonNull(keyBytes, "keyBytes cannot be null");
        if (keyBytes.length != 32) {
            throw new IllegalArgumentException(
                    "AES-256 requires exactly 32 key bytes; got " + keyBytes.length);
        }
        return new SecretKeySpec(keyBytes, "AES");
    }

    /**
     * Encrypts a float-array voice embedding and returns a Base64-encoded ciphertext string
     * suitable for storage in a VARCHAR or TEXT database column.
     *
     * <p>Wire format: {@code Base64([12-byte IV][encrypted float bytes][16-byte GCM tag])}</p>
     *
     * @param embedding plaintext embedding vector (must not be {@code null} or empty)
     * @param key       AES-256 encryption key
     * @return Base64-encoded ciphertext string
     * @throws IllegalArgumentException if {@code embedding} is null or empty
     * @throws EmbeddingEncryptionException if encryption fails
     */
    public String encryptEmbedding(float[] embedding, SecretKey key) {
        Objects.requireNonNull(embedding, "embedding cannot be null");
        Objects.requireNonNull(key, "key cannot be null");
        if (embedding.length == 0) {
            throw new IllegalArgumentException("embedding must not be empty");
        }
        byte[] plaintext = floatsToBytes(embedding);
        return encryptBytes(plaintext, key);
    }

    /**
     * Decrypts a Base64-encoded ciphertext string back to a float-array voice embedding.
     *
     * @param ciphertext Base64-encoded ciphertext produced by {@link #encryptEmbedding}
     * @param key        AES-256 decryption key
     * @return decrypted embedding vector
     * @throws IllegalArgumentException if {@code ciphertext} is null or blank
     * @throws EmbeddingEncryptionException if decryption or authentication fails
     */
    public float[] decryptEmbedding(String ciphertext, SecretKey key) {
        Objects.requireNonNull(ciphertext, "ciphertext cannot be null");
        Objects.requireNonNull(key, "key cannot be null");
        if (ciphertext.isBlank()) {
            throw new IllegalArgumentException("ciphertext must not be blank");
        }
        byte[] plaintext = decryptBytes(ciphertext, key);
        return bytesToFloats(plaintext);
    }

    /**
     * Encrypts raw byte payload (e.g., audio metadata serialized to JSON) using AES-256-GCM.
     *
     * @param plaintext raw bytes to encrypt
     * @param key       AES-256 encryption key
     * @return Base64-encoded ciphertext string
     * @throws EmbeddingEncryptionException if encryption fails
     */
    public String encryptBytes(byte[] plaintext, SecretKey key) {
        Objects.requireNonNull(plaintext, "plaintext cannot be null");
        Objects.requireNonNull(key, "key cannot be null");
        try {
            byte[] iv = new byte[GCM_IV_LENGTH_BYTES];
            secureRandom.nextBytes(iv);

            Cipher cipher = Cipher.getInstance(ALGORITHM);
            cipher.init(Cipher.ENCRYPT_MODE, key, new GCMParameterSpec(GCM_TAG_LENGTH_BITS, iv));
            byte[] ciphertext = cipher.doFinal(plaintext);

            // Prepend IV to ciphertext
            byte[] combined = new byte[iv.length + ciphertext.length];
            System.arraycopy(iv, 0, combined, 0, iv.length);
            System.arraycopy(ciphertext, 0, combined, iv.length, ciphertext.length);

            return Base64.getEncoder().encodeToString(combined);
        } catch (Exception e) {
            throw new EmbeddingEncryptionException("Encryption failed", e);
        }
    }

    /**
     * Decrypts a Base64-encoded ciphertext string produced by {@link #encryptBytes}.
     *
     * @param encoded Base64-encoded ciphertext
     * @param key     AES-256 decryption key
     * @return decrypted bytes
     * @throws EmbeddingEncryptionException if decryption or GCM authentication fails
     */
    public byte[] decryptBytes(String encoded, SecretKey key) {
        Objects.requireNonNull(encoded, "encoded cannot be null");
        Objects.requireNonNull(key, "key cannot be null");
        try {
            byte[] combined = Base64.getDecoder().decode(encoded);
            if (combined.length < GCM_IV_LENGTH_BYTES) {
                throw new EmbeddingEncryptionException(
                        "Ciphertext too short to contain IV; length=" + combined.length, null);
            }

            byte[] iv = new byte[GCM_IV_LENGTH_BYTES];
            System.arraycopy(combined, 0, iv, 0, GCM_IV_LENGTH_BYTES);
            byte[] ciphertext = new byte[combined.length - GCM_IV_LENGTH_BYTES];
            System.arraycopy(combined, GCM_IV_LENGTH_BYTES, ciphertext, 0, ciphertext.length);

            Cipher cipher = Cipher.getInstance(ALGORITHM);
            cipher.init(Cipher.DECRYPT_MODE, key, new GCMParameterSpec(GCM_TAG_LENGTH_BITS, iv));
            return cipher.doFinal(ciphertext);
        } catch (EmbeddingEncryptionException e) {
            throw e;
        } catch (Exception e) {
            throw new EmbeddingEncryptionException("Decryption or authentication failed", e);
        }
    }

    // -------------------------------------------------------------------------
    // Private helpers
    // -------------------------------------------------------------------------

    private static byte[] floatsToBytes(float[] floats) {
        ByteBuffer buf = ByteBuffer.allocate(floats.length * FLOATS_PER_BYTE)
                .order(ByteOrder.LITTLE_ENDIAN);
        for (float f : floats) {
            buf.putFloat(f);
        }
        return buf.array();
    }

    private static float[] bytesToFloats(byte[] bytes) {
        if (bytes.length % FLOATS_PER_BYTE != 0) {
            throw new EmbeddingEncryptionException(
                    "Plaintext byte count is not a multiple of 4; cannot convert to floats. Length=" + bytes.length,
                    null);
        }
        ByteBuffer buf = ByteBuffer.wrap(bytes).order(ByteOrder.LITTLE_ENDIAN);
        float[] floats = new float[bytes.length / FLOATS_PER_BYTE];
        for (int i = 0; i < floats.length; i++) {
            floats[i] = buf.getFloat();
        }
        return floats;
    }

    /**
     * Unchecked exception thrown when embedding encryption or decryption fails.
     */
    public static final class EmbeddingEncryptionException extends RuntimeException {

        EmbeddingEncryptionException(String message, Throwable cause) {
            super(message, cause);
        }
    }
}
