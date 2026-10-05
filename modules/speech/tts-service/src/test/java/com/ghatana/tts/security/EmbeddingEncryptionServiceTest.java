package com.ghatana.tts.security;

import com.ghatana.tts.security.EmbeddingEncryptionService.EmbeddingEncryptionException;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Nested;
import org.junit.jupiter.api.Test;

import javax.crypto.SecretKey;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;
import static org.assertj.core.api.Assertions.within;

/**
 * Unit tests for {@link EmbeddingEncryptionService}.
 *
 * @doc.type class
 * @doc.purpose Verifies AES-256-GCM round-trip, authentication, and error handling for voice embeddings
 * @doc.layer test
 * @doc.pattern Test
 */
@DisplayName("EmbeddingEncryptionService")
class EmbeddingEncryptionServiceTest {

    private EmbeddingEncryptionService service;
    private SecretKey key;

    @BeforeEach
    void setUp() {
        service = new EmbeddingEncryptionService();
        key = EmbeddingEncryptionService.generateKey();
    }

    @Nested
    @DisplayName("generateKey()")
    class GenerateKeyTests {

        @Test
        @DisplayName("generates a 256-bit AES key")
        void generateKey_returns256BitAesKey() {
            SecretKey k = EmbeddingEncryptionService.generateKey();
            assertThat(k.getAlgorithm()).isEqualTo("AES");
            assertThat(k.getEncoded()).hasSize(32);
        }

        @Test
        @DisplayName("each call produces a distinct key")
        void generateKey_eachCallDistinct() {
            SecretKey k1 = EmbeddingEncryptionService.generateKey();
            SecretKey k2 = EmbeddingEncryptionService.generateKey();
            assertThat(k1.getEncoded()).isNotEqualTo(k2.getEncoded());
        }
    }

    @Nested
    @DisplayName("keyFromBytes()")
    class KeyFromBytesTests {

        @Test
        @DisplayName("accepts exactly 32 bytes")
        void keyFromBytes_32ByteArray_accepted() {
            byte[] raw = new byte[32];
            SecretKey k = EmbeddingEncryptionService.keyFromBytes(raw);
            assertThat(k.getAlgorithm()).isEqualTo("AES");
        }

        @Test
        @DisplayName("rejects non-32-byte arrays")
        void keyFromBytes_wrongLength_throws() {
            assertThatThrownBy(() -> EmbeddingEncryptionService.keyFromBytes(new byte[16]))
                    .isInstanceOf(IllegalArgumentException.class)
                    .hasMessageContaining("32");
        }
    }

    @Nested
    @DisplayName("encryptEmbedding() / decryptEmbedding()")
    class EmbeddingRoundTripTests {

        @Test
        @DisplayName("round-trip returns original embedding values")
        void roundTrip_returnsOriginalValues() {
            float[] original = {0.1f, 0.5f, -0.3f, 1.0f, 0.0f};
            String ciphertext = service.encryptEmbedding(original, key);
            float[] decrypted = service.decryptEmbedding(ciphertext, key);
            assertThat(decrypted).hasSameSizeAs(original);
            for (int i = 0; i < original.length; i++) {
                assertThat(decrypted[i]).isCloseTo(original[i], within(1e-6f));
            }
        }

        @Test
        @DisplayName("ciphertext differs on each encryption (random IV)")
        void encrypt_randomIv_ciphertextDiffers() {
            float[] embedding = {0.1f, 0.2f, 0.3f};
            String c1 = service.encryptEmbedding(embedding, key);
            String c2 = service.encryptEmbedding(embedding, key);
            assertThat(c1).isNotEqualTo(c2);
        }

        @Test
        @DisplayName("ciphertext does not contain plaintext float bytes as printable string")
        void ciphertext_doesNotLeakPlaintext() {
            float[] embedding = {1.0f, 2.0f, 3.0f};
            String ciphertext = service.encryptEmbedding(embedding, key);
            // The raw float bytes for 1.0f as hex is "0000803f" — should not appear in Base64 output
            assertThat(ciphertext).doesNotContain("1.0");
        }

        @Test
        @DisplayName("decryption with wrong key throws EmbeddingEncryptionException")
        void decrypt_wrongKey_throws() {
            float[] embedding = {0.1f, 0.2f};
            String ciphertext = service.encryptEmbedding(embedding, key);
            SecretKey wrongKey = EmbeddingEncryptionService.generateKey();
            assertThatThrownBy(() -> service.decryptEmbedding(ciphertext, wrongKey))
                    .isInstanceOf(EmbeddingEncryptionException.class)
                    .hasMessageContaining("authentication");
        }

        @Test
        @DisplayName("tampered ciphertext fails authentication")
        void decrypt_tamperedCiphertext_throws() {
            float[] embedding = {0.5f, -0.5f};
            String ciphertext = service.encryptEmbedding(embedding, key);
            // Flip a character in the middle
            char[] chars = ciphertext.toCharArray();
            chars[ciphertext.length() / 2] ^= 1;
            String tampered = new String(chars);
            assertThatThrownBy(() -> service.decryptEmbedding(tampered, key))
                    .isInstanceOf(EmbeddingEncryptionException.class);
        }

        @Test
        @DisplayName("rejects null embedding")
        void encrypt_nullEmbedding_throws() {
            assertThatThrownBy(() -> service.encryptEmbedding(null, key))
                    .isInstanceOf(NullPointerException.class);
        }

        @Test
        @DisplayName("rejects empty embedding")
        void encrypt_emptyEmbedding_throws() {
            assertThatThrownBy(() -> service.encryptEmbedding(new float[0], key))
                    .isInstanceOf(IllegalArgumentException.class);
        }
    }

    @Nested
    @DisplayName("encryptBytes() / decryptBytes()")
    class ByteRoundTripTests {

        @Test
        @DisplayName("round-trip returns original bytes")
        void roundTrip_returnsOriginalBytes() {
            byte[] original = "voice metadata payload".getBytes();
            String ciphertext = service.encryptBytes(original, key);
            byte[] decrypted = service.decryptBytes(ciphertext, key);
            assertThat(decrypted).isEqualTo(original);
        }

        @Test
        @DisplayName("too-short ciphertext throws EmbeddingEncryptionException")
        void decrypt_tooShortCiphertext_throws() {
            // Base64 of fewer than 12 bytes
            String tooShort = java.util.Base64.getEncoder().encodeToString(new byte[5]);
            assertThatThrownBy(() -> service.decryptBytes(tooShort, key))
                    .isInstanceOf(EmbeddingEncryptionException.class)
                    .hasMessageContaining("too short");
        }
    }
}
