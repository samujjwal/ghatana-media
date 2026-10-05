package com.ghatana.stt.vocabulary;

import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Nested;
import org.junit.jupiter.api.Test;

import java.util.List;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatIllegalArgumentException;
import static org.assertj.core.api.Assertions.assertThatNullPointerException;

/**
 * Unit tests for {@link CustomVocabularyManager} — AV-007.3.
 *
 * @doc.type class
 * @doc.purpose Unit tests for the custom vocabulary manager
 * @doc.layer product
 * @doc.pattern Test
 */
@DisplayName("CustomVocabularyManager")
class CustomVocabularyManagerTest {

    // ─── empty / of ───────────────────────────────────────────────────────────

    @Test
    @DisplayName("empty(): no terms, size 0")
    void empty_noTerms() { 
        CustomVocabularyManager mgr = CustomVocabularyManager.empty(); 
        assertThat(mgr.isEmpty()).isTrue(); 
        assertThat(mgr.size()).isZero(); 
    }

    @Test
    @DisplayName("of(List): pre-populates terms")
    void of_list_populatesTerms() { 
        CustomVocabularyManager mgr = CustomVocabularyManager.of(List.of("Ghatana", "ActiveJ")); 
        assertThat(mgr.size()).isEqualTo(2); 
        assertThat(mgr.contains("ghatana")).isTrue();
        assertThat(mgr.contains("activej")).isTrue();
    }

    @Test
    @DisplayName("of(null) throws NullPointerException")
    void of_null_throwsNPE() { 
        assertThatNullPointerException() 
                .isThrownBy(() -> CustomVocabularyManager.of(null)); 
    }

    // ─── addTerm ──────────────────────────────────────────────────────────────

    @Nested
    @DisplayName("addTerm()")
    class AddTerm {

        @Test
        @DisplayName("adds a single term and makes it findable")
        void addTerm_singleTerm() { 
            CustomVocabularyManager mgr = CustomVocabularyManager.empty(); 
            mgr.addTerm("hyperparameter");
            assertThat(mgr.contains("Hyperparameter")).isTrue(); // case-insensitive
        }

        @Test
        @DisplayName("duplicate terms are deduplicated")
        void addTerm_deduplication() { 
            CustomVocabularyManager mgr = CustomVocabularyManager.empty(); 
            mgr.addTerm("Ghatana");
            mgr.addTerm("ghatana"); // same after normalisation
            assertThat(mgr.size()).isEqualTo(1); 
        }

        @Test
        @DisplayName("adding same term with new weight updates the weight")
        void addTerm_updateWeight() { 
            CustomVocabularyManager mgr = CustomVocabularyManager.empty(); 
            mgr.addTerm("eventloop", 1.0); 
            mgr.addTerm("eventloop", 5.0); 
            assertThat(mgr.size()).isEqualTo(1); 
            assertThat(mgr.terms().get(0).weight()).isEqualTo(5.0); 
        }

        @Test
        @DisplayName("blank term throws IllegalArgumentException")
        void addTerm_blank_throwsIAE() { 
            CustomVocabularyManager mgr = CustomVocabularyManager.empty(); 
            assertThatIllegalArgumentException() 
                    .isThrownBy(() -> mgr.addTerm("   "));
        }

        @Test
        @DisplayName("null term throws NullPointerException")
        void addTerm_null_throwsNPE() { 
            CustomVocabularyManager mgr = CustomVocabularyManager.empty(); 
            assertThatNullPointerException() 
                    .isThrownBy(() -> mgr.addTerm(null)); 
        }

        @Test
        @DisplayName("weight < 0.1 throws IllegalArgumentException")
        void addTerm_invalidWeightLow_throwsIAE() { 
            CustomVocabularyManager mgr = CustomVocabularyManager.empty(); 
            assertThatIllegalArgumentException() 
                    .isThrownBy(() -> mgr.addTerm("term", 0.0)); 
        }

        @Test
        @DisplayName("weight > 10.0 throws IllegalArgumentException")
        void addTerm_invalidWeightHigh_throwsIAE() { 
            CustomVocabularyManager mgr = CustomVocabularyManager.empty(); 
            assertThatIllegalArgumentException() 
                    .isThrownBy(() -> mgr.addTerm("term", 10.1)); 
        }
    }

    // ─── removeTerm ───────────────────────────────────────────────────────────

    @Nested
    @DisplayName("removeTerm()")
    class RemoveTerm {

        @Test
        @DisplayName("removes existing term and returns true")
        void removeTerm_existing_returnsTrue() { 
            CustomVocabularyManager mgr = CustomVocabularyManager.of(List.of("eventloop"));
            assertThat(mgr.removeTerm("EventLoop")).isTrue();
            assertThat(mgr.contains("eventloop")).isFalse();
        }

        @Test
        @DisplayName("removing non-existing term returns false")
        void removeTerm_nonExisting_returnsFalse() { 
            CustomVocabularyManager mgr = CustomVocabularyManager.empty(); 
            assertThat(mgr.removeTerm("nonexistent")).isFalse();
        }

        @Test
        @DisplayName("null term throws NullPointerException")
        void removeTerm_null_throwsNPE() { 
            CustomVocabularyManager mgr = CustomVocabularyManager.empty(); 
            assertThatNullPointerException() 
                    .isThrownBy(() -> mgr.removeTerm(null)); 
        }
    }

    // ─── apply ────────────────────────────────────────────────────────────────

    @Test
    @DisplayName("apply: returns transcript unchanged (model applies hints internally)")
    void apply_returnsTranscriptUnchanged() { 
        CustomVocabularyManager mgr = CustomVocabularyManager.of(List.of("Ghatana"));
        String transcript = "Welcome to Ghatana platform";
        assertThat(mgr.apply(transcript)).isEqualTo(transcript); 
    }

    @Test
    @DisplayName("apply: null transcript throws NullPointerException")
    void apply_null_throwsNPE() { 
        CustomVocabularyManager mgr = CustomVocabularyManager.empty(); 
        assertThatNullPointerException() 
                .isThrownBy(() -> mgr.apply(null)); 
    }

    // ─── exportTermStrings ────────────────────────────────────────────────────

    @Test
    @DisplayName("exportTermStrings: returns normalised lowercase terms")
    void exportTermStrings_normalised() { 
        CustomVocabularyManager mgr = CustomVocabularyManager.of(List.of("Ghatana", "ActiveJ")); 
        List<String> exported = mgr.exportTermStrings(); 
        assertThat(exported).containsExactlyInAnyOrder("ghatana", "activej"); 
    }

    // ─── terms() snapshot ──────────────────────────────────────────────────── 

    @Test
    @DisplayName("terms(): returns unmodifiable snapshot")
    void terms_unmodifiableSnapshot() { 
        CustomVocabularyManager mgr = CustomVocabularyManager.of(List.of("a"));
        var snap = mgr.terms(); 
        assertThat(snap).hasSize(1); 
        mgr.addTerm("b");
        assertThat(snap).hasSize(1); // snapshot unchanged 
    }
}
