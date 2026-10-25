package com.ghatana.stt.vocabulary;

import com.ghatana.stt.testutil.LogCapture;
import org.junit.jupiter.api.Test;

import static org.assertj.core.api.Assertions.assertThat;

class CustomVocabularyManagerLogPrivacyTest {
    @Test
    void addingAndRemovingTermDoNotWriteVocabularyTextToLogs() {
        String marker = "private-vocabulary-marker";
        CustomVocabularyManager manager = CustomVocabularyManager.empty();

        try (LogCapture logs = LogCapture.capture(CustomVocabularyManager.class)) {
            manager.addTerm(marker, 2.0);
            assertThat(manager.removeTerm(marker)).isTrue();

            assertThat(logs.output()).contains("Vocabulary term added", "Vocabulary term removed")
                    .doesNotContain(marker);
        }
    }
}
